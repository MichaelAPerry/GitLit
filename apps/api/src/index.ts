import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { GitLitError, assertAgentWritable, forbidden, newRepoId, notFound } from "@gitlit/core";
import {
  beatsForChapter, chapterIdForPath, diffPlanToProse, diffProse, paragraphsOf,
  DERIVATION_ALGO_VERSION,
} from "@gitlit/diff";
import { countWords, denormalize, parseArchitecture } from "@gitlit/prose";
import { gitd } from "./gitd-client.js";
import { initDb } from "./db.js";
import {
  auth, clearSessionCookie, oauth, requireAccess, requireUser, resolvePrincipal,
  setSessionCookie, PUBLIC_URL, WEB_URL,
} from "./auth-plugin.js";
import { ALL_SCOPES, MAGIC_LINK_TTL_MS, OAuthError, authorize, type Scope } from "@gitlit/auth";
import { createMailer } from "@gitlit/mail";
import { repos, type RepoRecord } from "./repos.js";
import { authoringSessions, evidenceFor } from "./sessions.js";

export const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
await app.register(cors, { origin: true });

// Everything below needs a database; fail at startup rather than per request.
await initDb();

// Same reasoning for mail. A server that starts without a way to send sign-in
// links is a server nobody new can sign in to, and it looks perfectly healthy
// while being so (§2.2 of NEXT.md — this was the blocker).
export const mailer = createMailer();

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof GitLitError) return reply.status(err.status).send(err.toProblem());
  if (err instanceof OAuthError) {
    return reply.status(400).send({
      type: `https://gitlit.app/errors/oauth-${err.code}`,
      title: "Sign-in failed", status: 400, detail: err.message,
    });
  }
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

  try {
    const result = await mailer.sendMagicLink(body.email, token, MAGIC_LINK_TTL_MS / 60_000);
    // Never the address and never the token: this line ends up in a log
    // aggregator, and a sign-in link in a log is a sign-in link anyone with
    // log access can use.
    app.log.info({ via: result.via, providerId: result.id }, "magic link sent");
  } catch (err) {
    app.log.error({ err }, "magic link could not be sent");
    /**
     * Reporting this is safe. Whether the mail provider is reachable does not
     * depend on who asked, so the failure says nothing about whether the
     * address has an account — and an author who is told plainly that sending
     * failed will try again, where one told "a link is on its way" waits for
     * a message that is never coming.
     */
    throw new GitLitError(
      "mail-unavailable", 502, "Could not send the email",
      "We could not send the sign-in email just now. Please try again in a moment.",
    );
  }

  const devToken = process.env.NODE_ENV === "production" ? undefined : token;
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

// ------------------------------------------------------------------ oauth

app.get("/v1/auth/providers", async () => ({ providers: oauth.available() }));

const callbackUri = (provider: string) => `${PUBLIC_URL}/v1/auth/oauth/${provider}/callback`;

/** Start a provider sign-in. Redirects the browser to the provider. */
app.get("/v1/auth/oauth/:provider", async (req, reply) => {
  const { provider } = req.params as { provider: string };
  const q = z.object({ returnTo: z.string().optional(), link: z.coerce.boolean().default(false) })
    .parse(req.query);

  // `link` attaches a provider to the account already signed in here.
  const linkUserId = q.link ? requireUser(req).userId : undefined;

  const { url } = await oauth.begin({
    provider,
    redirectUri: callbackUri(provider),
    returnTo: q.returnTo,
    linkUserId,
  });
  return reply.redirect(url, 302);
});

/**
 * Provider callback. Ends at the web app either way — a raw JSON error on a
 * redirect from GitHub is a dead end for someone who only wanted to sign in.
 */
app.get("/v1/auth/oauth/:provider/callback", async (req, reply) => {
  const { provider } = req.params as { provider: string };
  const q = z.object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  }).parse(req.query);

  const fail = (message: string) =>
    reply.redirect(`${WEB_URL}/signin?error=${encodeURIComponent(message)}`, 302);

  // The author declined at the provider; not an error worth alarming them over.
  if (q.error) {
    return fail(q.error === "access_denied"
      ? "Sign-in was cancelled."
      : q.error_description ?? q.error);
  }
  if (!q.code || !q.state) return fail("That sign-in link was incomplete. Please try again.");

  try {
    const result = await oauth.complete({
      provider, code: q.code, state: q.state, redirectUri: callbackUri(provider),
    });
    setSessionCookie(reply, result.sessionToken);
    const target = new URL(result.returnTo, WEB_URL);
    target.searchParams.set("session", result.sessionToken);
    return reply.redirect(target.toString(), 302);
  } catch (err) {
    app.log.warn({ err, provider }, "oauth callback failed");
    return fail(err instanceof Error ? err.message : "Sign-in failed.");
  }
});

app.get("/v1/me/providers", async (req) => {
  const principal = requireUser(req);
  return { providers: await oauth.linkedProviders(principal.userId) };
});

app.delete("/v1/me/providers/:provider", async (req) => {
  const principal = requireUser(req);
  const { provider } = req.params as { provider: string };
  const removed = await oauth.unlink(principal.userId, provider);
  if (!removed) throw notFound(`No linked ${provider} account`);
  return { unlinked: true };
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

/**
 * Internal: authorize a Git transport request (§12.7).
 *
 * gitd owns the repository volume and speaks the Git protocol, but must not
 * own authorization too — that lives here, so the same authorize() decision
 * covers a browser request and a `git push`. Service-token protected.
 */
app.post("/v1/internal/git-access", async (req) => {
  const body = z.object({
    owner: z.string(),
    slug: z.string(),
    capability: z.enum(["repo:read", "repo:write"]),
    credential: z.string().optional(),
  }).parse(req.body);

  const repo = await repos.find(body.owner, body.slug);
  if (!repo) return { allowed: false, reason: "not_found" };

  const principal = body.credential ? await auth.resolve(body.credential) : null;
  const decision = authorize({
    principal,
    capability: body.capability,
    repo: { id: repo.id, ownerUserId: repo.ownerUserId, visibility: repo.visibility },
    collaborators: repo.collaborators,
  });

  return {
    allowed: decision.allowed,
    reason: decision.reason,
    authenticated: principal !== null,
    repoId: repo.id,
    storagePath: repo.storagePath,
    userId: principal?.userId,
  };
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

/**
 * Mode A — Plan vs. Prose (§9.1). The flagship view.
 *
 * Compares a chapter against the beats planned for it in
 * manuscript_architecture.md, and reports where the prose followed the plan,
 * grew it, left it, or was never in it at all.
 */
app.get("/v1/repositories/:owner/:slug/diff/plan", async (req) => {
  const { owner, slug } = req.params as { owner: string; slug: string };
  const repo = await mustFind(owner, slug);
  requireAccess(req, repo, "repo:read");
  const q = z.object({
    path: z.string(),
    ref: z.string().default("refs/heads/main"),
    chapter: z.string().optional(),
  }).parse(req.query);

  const [chapter, architecture] = await Promise.all([
    gitd.readBlob(repo.id, q.path, q.ref),
    gitd.readBlob(repo.id, "manuscript_architecture.md", q.ref),
  ]);
  if (chapter.content === null) throw notFound(q.path);

  if (architecture.content === null) {
    return {
      path: q.path,
      hasPlan: false,
      note: "This book has no manuscript_architecture.md, so there is no plan to compare against. " +
            "Every word is the author's own by default, not by measurement.",
    };
  }

  const parsed = parseArchitecture(architecture.content);
  const chapterId = q.chapter ?? chapterIdForPath(q.path);
  const beats = chapterId ? beatsForChapter(parsed.beats, chapterId) : parsed.beats;
  const paragraphs = paragraphsOf(chapter.content);
  const result = diffPlanToProse(beats, paragraphs);

  return {
    path: q.path,
    hasPlan: true,
    chapterId,
    beats,
    paragraphs,
    ...result,
    caveat: "Derivation is computed from declared links and lexical overlap, deterministically, " +
            "so anyone with a clone can reproduce it offline. It measures textual descent from " +
            "the plan, not literary quality or effort.",
  };
});

/** The headline divergence metric across the whole manuscript (§9.1). */
app.get("/v1/repositories/:owner/:slug/divergence", async (req) => {
  const { owner, slug } = req.params as { owner: string; slug: string };
  const repo = await mustFind(owner, slug);
  requireAccess(req, repo, "repo:provenance");
  const q = z.object({ ref: z.string().default("refs/heads/main") }).parse(req.query);

  const [tree, architecture] = await Promise.all([
    gitd.tree(repo.id, q.ref),
    gitd.readBlob(repo.id, "manuscript_architecture.md", q.ref),
  ]);
  if (architecture.content === null) return { hasPlan: false, chapters: [] };

  const parsed = parseArchitecture(architecture.content);
  const chapterPaths = tree.entries.filter((p) => p.startsWith("manuscript/chapters/"));

  const chapters = await Promise.all(chapterPaths.map(async (path) => {
    const { content } = await gitd.readBlob(repo.id, path, q.ref);
    const chapterId = chapterIdForPath(path);
    const beats = chapterId ? beatsForChapter(parsed.beats, chapterId) : [];
    const result = diffPlanToProse(beats, paragraphsOf(content ?? ""));
    return { path, chapterId, divergence: result.divergence, counts: result.counts };
  }));

  const totals = chapters.reduce((acc, c) => ({
    departedWords: acc.departedWords + c.divergence.departedWords,
    unplannedWords: acc.unplannedWords + c.divergence.unplannedWords,
    plannedWords: acc.plannedWords + c.divergence.plannedWords,
    totalWords: acc.totalWords + c.divergence.totalWords,
  }), { departedWords: 0, unplannedWords: 0, plannedWords: 0, totalWords: 0 });

  return {
    hasPlan: true,
    chapters,
    divergence: {
      ...totals,
      score: totals.totalWords === 0
        ? 0
        : Number(((totals.departedWords + totals.unplannedWords) / totals.totalWords).toFixed(4)),
    },
    algoVersion: DERIVATION_ALGO_VERSION,
  };
});

/** Mode B — provenance heat for one file: spans as committed (§9.2). */
app.get("/v1/repositories/:owner/:slug/provenance/*", async (req) => {
  const { owner, slug, "*": path } = req.params as { owner: string; slug: string; "*": string };
  const repo = await mustFind(owner, slug);
  requireAccess(req, repo, "repo:provenance");
  const q = z.object({ ref: z.string().default("refs/heads/main") }).parse(req.query);

  const [file, sidecar] = await Promise.all([
    gitd.readBlob(repo.id, path, q.ref),
    gitd.readBlob(repo.id, `.gitlit/provenance/${path}.jsonl`, q.ref),
  ]);
  if (file.content === null) throw notFound(path);

  const spans = (sidecar.content ?? "")
    .split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  return {
    path,
    content: file.content,
    spans,
    caveat: "Spans record what GitLit observed. Text marked as written here could have been " +
            "composed elsewhere and retyped; the record is evidence, not proof.",
  };
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

// Tests drive the app with `inject` and must not bind a port.
if (process.env.GITLIT_NO_LISTEN !== "1" && process.env.VITEST !== "true") {
  const port = Number(process.env.API_PORT ?? 4000);
  app.listen({ port, host: "0.0.0.0" }).catch((e) => { app.log.error(e); process.exit(1); });
}
