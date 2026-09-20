import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { GitLitError, assertAgentWritable, forbidden, newRepoId, notFound } from "@gitlit/core";
import { diffProse } from "@gitlit/diff";
import { countWords, denormalize } from "@gitlit/prose";
import { gitd } from "./gitd-client.js";
import { initDb } from "./db.js";
import {
  auth, clearSessionCookie, requireAccess, requireUser, resolvePrincipal, setSessionCookie,
} from "./auth-plugin.js";
import { ALL_SCOPES, type Scope } from "@gitlit/auth";
import { repos, type RepoRecord } from "./repos.js";
import { authoringSessions, evidenceFor } from "./sessions.js";

export const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
await app.register(cors, { origin: true });

// Everything below needs a database; fail at startup rather than per request.
await initDb();

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof GitLitError) return reply.status(err.status).send(err.toProblem());
  app.log.error(err);
  return reply.status(500).send({ title: "Internal error", status: 500 });
});

app.addHook("onRequest", async (req) => { req.principal = await resolvePrincipal(req); });

async function mustFind(owner: string, slug: string): Promise<RepoRecord> {
  const r = await repos.find(owner, slug);
  if (!r) throw notFound(`Repository ${owner}/${slug}`);
  return r;
}

/** Git identity for a commit, taken from the signed-in user — never the client. */
async function committer(userId: string) {
  const user = await auth.getUser(userId);
  if (!user) throw notFound("User");
  return { name: user.displayName ?? user.handle, email: user.email, id: user.id };
}

app.get("/health", async () => ({ ok: true, service: "api" }));

// ------------------------------------------------------------------- auth

/**
 * Passwordless sign-in. In development the token comes back in the response so
 * the flow is usable without a mail server; in production it is only emailed.
 */
app.post("/v1/auth/magic-link", async (req) => {
  const body = z.object({ email: z.string().email() }).parse(req.body);
  const { token } = await auth.issueMagicLink(body.email);
  const devToken = process.env.NODE_ENV === "production" ? undefined : token;
  app.log.info({ email: body.email }, "magic link issued");
  return {
    sent: true,
    // Same response whether or not the address is known, so this endpoint
    // cannot be used to enumerate who has a GitLit account.
    message: "If that address can sign in, a link is on its way.",
    devToken,
  };
});

app.post("/v1/auth/session", async (req, reply) => {
  const body = z.object({ token: z.string() }).parse(req.body);
  const result = await auth.consumeMagicLink(body.token);
  if (!result) {
    throw new GitLitError("invalid-link", 401, "Invalid link", "That sign-in link is invalid, used, or expired.");
  }
  setSessionCookie(reply, result.sessionToken);
  return { user: result.user, sessionToken: result.sessionToken };
});

app.post("/v1/auth/signout", async (req, reply) => {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) await auth.revokeSession(header.slice(7).trim());
  clearSessionCookie(reply);
  return { signedOut: true };
});

app.get("/v1/me", async (req) => {
  const principal = requireUser(req);
  const user = await auth.getUser(principal.userId);
  if (!user) throw notFound("User");
  return { user, via: principal.via, scopes: principal.scopes };
});

// ------------------------------------------------------------- api tokens

app.get("/v1/tokens", async (req) => {
  const principal = requireUser(req);
  // Never serve the verifier or selector — they are the credential material.
  return {
    tokens: (await auth.listTokens(principal.userId)).map((t) => ({
      id: t.id, name: t.name, scopes: t.scopes, createdAt: t.createdAt,
      expiresAt: t.expiresAt, lastUsedAt: t.lastUsedAt,
    })),
  };
});

app.post("/v1/tokens", async (req, reply) => {
  const principal = requireUser(req);
  // A token may never be minted with more than the presenter already holds,
  // or a narrow token could bootstrap a broad one.
  if (principal.via === "token") {
    throw forbidden("Create tokens from a signed-in browser session, not with another token.");
  }
  const body = z.object({
    name: z.string().min(1).max(60),
    scopes: z.array(z.enum(ALL_SCOPES as [Scope, ...Scope[]])).min(1),
    expiresAt: z.string().datetime().optional(),
  }).parse(req.body);

  const { token, record } = await auth.issueToken({ userId: principal.userId, ...body });
  return reply.status(201).send({
    token,
    record: {
      id: record.id, name: record.name, scopes: record.scopes,
      createdAt: record.createdAt, expiresAt: record.expiresAt,
    },
    note: "Copy this now — it is not shown again.",
  });
});

app.delete("/v1/tokens/:id", async (req) => {
  const principal = requireUser(req);
  const { id } = req.params as { id: string };
  if (!await auth.revokeToken(principal.userId, id)) throw notFound(`Token ${id}`);
  return { revoked: true };
});

// ----------------------------------------------------------- repositories

app.get("/v1/repositories", async (req) => ({
  repositories: await repos.listFor(req.principal?.userId ?? null),
}));

app.post("/v1/repositories", async (req, reply) => {
  const principal = requireUser(req);
  if (!principal.scopes.includes("repo:write")) {
    throw forbidden("This credential cannot create books.");
  }
  const owner = await auth.getUser(principal.userId);
  if (!owner) throw notFound("User");
  const body = z.object({
    title: z.string().min(1),
    slug: z.string().regex(/^[a-z0-9-]+$/),
    form: z.enum(["novel", "nonfiction", "memoir", "collection"]),
    genre: z.array(z.string()).default([]),
    targetWords: z.number().int().positive().optional(),
    premise: z.string().optional(),
    visibility: z.enum(["private", "unlisted", "public"]).default("private"),
  }).parse(req.body);

  if (await repos.find(owner.handle, body.slug)) {
    throw new GitLitError("conflict", 409, "Conflict", `You already have a book at ${body.slug}.`);
  }

  const id = newRepoId();
  const { gitdir } = await gitd.createRepo(id);
  const record = await repos.create({
    id, ownerHandle: owner.handle, ownerUserId: owner.id, storagePath: gitdir, ...body,
  });

  await gitd.commit(id, {
    ref: "refs/heads/main",
    message: `Create ${body.title}`,
    author: await committer(principal.userId),
    newTextOrigin: "human_written",
    evidence: ["repo_created"],
    changes: [
      { path: "book.yml", content: `title: ${body.title}\nform: ${body.form}\n` },
      ...(body.premise
        ? [{ path: ".gitlit/premise.md", content: `${body.premise}\n` }]
        : []),
    ],
  });

  return reply.status(201).send(record);
});

app.get("/v1/repositories/:owner/:slug", async (req) => {
  const { owner, slug } = req.params as { owner: string; slug: string };
  const repo = await mustFind(owner, slug);
  requireAccess(req, repo, "repo:read");
  const tree = await gitd.tree(repo.id);
  return { ...repo, head: tree.head, files: tree.entries };
});

// ------------------------------------------------------ manuscript content

app.get("/v1/repositories/:owner/:slug/documents", async (req) => {
  const { owner, slug } = req.params as { owner: string; slug: string };
  const repo = await mustFind(owner, slug);
  requireAccess(req, repo, "repo:read");
  const tree = await gitd.tree(repo.id);
  const chapters = tree.entries.filter((p) => p.startsWith("manuscript/chapters/"));

  const documents = await Promise.all(chapters.map(async (path) => {
    const { content } = await gitd.readBlob(repo.id, path);
    return {
      path,
      title: /^---[\s\S]*?\btitle:\s*(.+)$/m.exec(content ?? "")?.[1]?.trim() ?? path,
      wordCount: countWords(content ?? ""),
    };
  }));
  return { documents: documents.sort((a, b) => a.path.localeCompare(b.path)) };
});

app.get("/v1/repositories/:owner/:slug/documents/*", async (req) => {
  const { owner, slug, "*": path } = req.params as { owner: string; slug: string; "*": string };
  const repo = await mustFind(owner, slug);
  requireAccess(req, repo, "repo:read");
  const q = z.object({ ref: z.string().default("refs/heads/main"), flow: z.coerce.boolean().default(false) }).parse(req.query);
  const { content } = await gitd.readBlob(repo.id, path, q.ref);
  if (content === null) throw notFound(path);
  return {
    path,
    content: q.flow ? denormalize(content) : content,
    wordCount: countWords(content),
  };
});

/**
 * Hot path (§12.3): normalize, recompute spans, commit, sign, emit a receipt,
 * and return the new provenance summary in one round trip.
 */
app.put("/v1/repositories/:owner/:slug/documents/*", async (req) => {
  const { owner, slug, "*": path } = req.params as { owner: string; slug: string; "*": string };
  const repo = await mustFind(owner, slug);
  requireAccess(req, repo, "repo:write");
  const principal = requireUser(req);
  const body = z.object({
    content: z.string(),
    message: z.string().default("Update manuscript"),
    evidence: z.array(z.string()).default([]),
    authoringSessionId: z.string().optional(),
  }).parse(req.body);

  // Evidence is derived from what we actually recorded for the session, not
  // from what the client asserts about itself.
  const session = body.authoringSessionId
    ? await authoringSessions.get(body.authoringSessionId)
    : undefined;
  const evidence = session ? evidenceFor(session) : body.evidence;

  const result = await gitd.commit(repo.id, {
    ref: "refs/heads/main",
    message: body.message,
    author: await committer(principal.userId),
    newTextOrigin: "human_written",
    evidence,
    changes: [{ path, content: body.content }],
  });
  if (session) await authoringSessions.attachCommit(session.id, result.sha);
  await repos.touch(repo.id);
  return { ...result, evidence };
});

app.get("/v1/repositories/:owner/:slug/collaborators", async (req) => {
  const { owner, slug } = req.params as { owner: string; slug: string };
  const repo = await mustFind(owner, slug);
  requireAccess(req, repo, "repo:read");
  return {
    collaborators: await Promise.all(repo.collaborators.map(async (c) => {
      const user = await auth.getUser(c.userId);
      return { userId: c.userId, handle: user?.handle, role: c.role };
    })),
  };
});

app.post("/v1/repositories/:owner/:slug/collaborators", async (req) => {
  const { owner, slug } = req.params as { owner: string; slug: string };
  const repo = await mustFind(owner, slug);
  requireAccess(req, repo, "repo:admin");
  const body = z.object({
    handle: z.string(),
    role: z.enum(["co_author", "editor", "beta_reader", "verifier"]),
  }).parse(req.body);

  const user = await auth.findUserByHandle(body.handle);
  if (!user) throw notFound(`User @${body.handle}`);
  if (user.id === repo.ownerUserId) {
    throw new GitLitError("conflict", 409, "Conflict", "The owner already has full access.");
  }
  await repos.addCollaborator(repo.id, user.id, body.role);
  return { added: true, handle: user.handle, role: body.role };
});

app.delete("/v1/repositories/:owner/:slug/collaborators/:handle", async (req) => {
  const { owner, slug, handle } = req.params as Record<string, string>;
  const repo = await mustFind(owner!, slug!);
  requireAccess(req, repo, "repo:admin");
  const user = await auth.findUserByHandle(handle!);
  if (!user) throw notFound(`User @${handle}`);
  await repos.removeCollaborator(repo.id, user.id);
  return { removed: true };
});

/**
 * The agent architecture commit (§8.3).
 *
 * Gated on `agent:research`, NOT `repo:write`: an MCP token carries the former
 * and not the latter, so the credential cannot author prose even if the path
 * allowlist below were bypassed. The allowlist is still enforced here and
 * again in gitd — three independent layers over one rule.
 */
app.post("/v1/repositories/:owner/:slug/architecture", async (req) => {
  const { owner, slug } = req.params as { owner: string; slug: string };
  const repo = await mustFind(owner, slug);
  requireAccess(req, repo, "agent:research");
  const principal = requireUser(req);

  const body = z.object({
    message: z.string().default("Add manuscript architecture"),
    agentSessionId: z.string().optional(),
    declaredModel: z.string().optional(),
    evidence: z.array(z.string()).default([]),
    changes: z.array(z.object({ path: z.string(), content: z.string() })).min(1),
  }).parse(req.body);

  for (const change of body.changes) assertAgentWritable(change.path);

  const user = (await auth.getUser(principal.userId))!;
  const result = await gitd.commit(repo.id, {
    ref: "refs/heads/main",
    message: body.message,
    author: {
      name: body.declaredModel ? `Agent via MCP (${user.handle})` : `Agent via MCP`,
      email: `agent+${user.handle}@gitlit.app`,
      id: user.id,
    },
    newTextOrigin: "ai_generated",
    agentSessionId: body.agentSessionId,
    declaredModel: body.declaredModel,
    evidence: body.evidence,
    changes: body.changes,
  });
  await repos.touch(repo.id);
  return result;
});

// -------------------------------------------------------- history & diffs

app.get("/v1/repositories/:owner/:slug/commits", async (req) => {
  const { owner, slug } = req.params as { owner: string; slug: string };
  const repo = await mustFind(owner, slug);
  requireAccess(req, repo, "repo:read");
  const entries = await gitd.log(repo.id);
  return {
    commits: entries.map((c) => ({
      ...c,
      subject: c.message.split("\n")[0],
      provenance: /GitLit-Provenance:\s*(\w+)/.exec(c.message)?.[1] ?? "unknown",
      receipt: /GitLit-Receipt:\s*(\S+)/.exec(c.message)?.[1],
    })),
  };
});

app.get("/v1/repositories/:owner/:slug/diff", async (req) => {
  const { owner, slug } = req.params as { owner: string; slug: string };
  const repo = await mustFind(owner, slug);
  requireAccess(req, repo, "repo:read");
  const q = z.object({ base: z.string(), head: z.string(), path: z.string() }).parse(req.query);
  const [base, head] = await Promise.all([
    gitd.readBlob(repo.id, q.path, q.base),
    gitd.readBlob(repo.id, q.path, q.head),
  ]);
  return diffProse(base.content ?? "", head.content ?? "");
});

app.get("/v1/repositories/:owner/:slug/provenance", async (req) => {
  const { owner, slug } = req.params as { owner: string; slug: string };
  const repo = await mustFind(owner, slug);
  requireAccess(req, repo, "repo:provenance");
  const tree = await gitd.tree(repo.id);
  const sidecars = tree.entries.filter((p) => p.startsWith(".gitlit/provenance/"));
  const spans = (await Promise.all(sidecars.map(async (p) => {
    const { content } = await gitd.readBlob(repo.id, p);
    return (content ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }))).flat();

  const byOrigin: Record<string, number> = {};
  for (const s of spans) byOrigin[s.origin] = (byOrigin[s.origin] ?? 0) + (s.end - s.start);
  return { spans: spans.length, charsByOrigin: byOrigin };
});

// ------------------------------------------------- authoring sessions (§7.5)

/**
 * Authoring sessions (§7.5). These endpoints persist what they accept — see
 * sessions.ts for why that is worth stating.
 */
app.post("/v1/repositories/:owner/:slug/sessions", async (req, reply) => {
  const { owner, slug } = req.params as { owner: string; slug: string };
  const repo = await mustFind(owner, slug);
  requireAccess(req, repo, "repo:write");
  const principal = requireUser(req);
  const body = z.object({
    path: z.string(),
    client: z.string().default("write_web"),
  }).parse(req.body);

  const session = await authoringSessions.open({
    repoId: repo.id, userId: principal.userId, path: body.path, client: body.client,
  });
  return reply.status(201).send({
    sessionId: session.id, path: session.path, startedAt: session.startedAt,
  });
});

/**
 * Aggregates and non-typed input events only. The client never sends a keylog
 * and the server would not store one (§7.5.1). Events carry a content hash,
 * never the text.
 */
app.patch("/v1/sessions/:id", async (req) => {
  const { id } = req.params as { id: string };
  const body = z.object({
    keystrokes: z.number().int().nonnegative().optional(),
    medianWpm: z.number().nullable().optional(),
    modeWords: z.record(z.number()).optional(),
    events: z.array(z.object({
      inputMode: z.enum(["pasted", "dictated", "composed", "dropped", "imported", "ai_tool", "synthetic"]),
      charCount: z.number().int(),
      wordCount: z.number().int(),
      contentHash: z.string(),
      isTrusted: z.boolean().default(true),
      occurredAt: z.string(),
    })).default([]),
  }).parse(req.body);

  const principal = requireUser(req);
  const existing = await authoringSessions.get(id);
  // Scoped to the owner: a session id must not let another user write into it.
  if (!existing || existing.userId !== principal.userId) throw notFound(`Authoring session ${id}`);
  const session = await authoringSessions.update(id, body);
  if (!session) throw notFound(`Authoring session ${id}`);
  return {
    sessionId: session.id,
    keystrokes: session.keystrokes,
    eventsRecorded: session.events.length,
    modeWords: session.modeWords,
  };
});

app.post("/v1/sessions/:id/close", async (req) => {
  const { id } = req.params as { id: string };
  const principal = requireUser(req);
  if ((await authoringSessions.get(id))?.userId !== principal.userId) throw notFound(`Authoring session ${id}`);
  const session = await authoringSessions.close(id);
  if (!session) throw notFound(`Authoring session ${id}`);
  return { sessionId: session.id, endedAt: session.endedAt, eventsRecorded: session.events.length };
});

app.get("/v1/sessions/:id", async (req) => {
  const { id } = req.params as { id: string };
  const principal = requireUser(req);
  const session = await authoringSessions.get(id);
  if (!session || session.userId !== principal.userId) throw notFound(`Authoring session ${id}`);
  return session;
});

/** The author's account of a paste, stored distinctly from what we observed. */
app.patch("/v1/sessions/:id/events/:contentHash", async (req) => {
  const { id, contentHash } = req.params as { id: string; contentHash: string };
  const principal = requireUser(req);
  if ((await authoringSessions.get(id))?.userId !== principal.userId) throw notFound(`Authoring session ${id}`);
  const body = z.object({ authorNote: z.string().min(1).max(500) }).parse(req.body);
  const event = await authoringSessions.annotate(id, contentHash, body.authorNote);
  if (!event) throw notFound(`Input event ${contentHash}`);
  return { recorded: true, event, note: "Stored as your account of this paste, not as an observation." };
});

app.get("/v1/repositories/:owner/:slug/sessions", async (req) => {
  const { owner, slug } = req.params as { owner: string; slug: string };
  const repo = await mustFind(owner, slug);
  requireAccess(req, repo, "repo:provenance");
  return { sessions: await authoringSessions.forRepo(repo.id) };
});

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.API_PORT ?? 4000);
  app.listen({ port, host: "0.0.0.0" }).catch((e) => { app.log.error(e); process.exit(1); });
}
