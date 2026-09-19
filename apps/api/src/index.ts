import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { GitLitError, newRepoId, newAuthoringSessionId, notFound } from "@gitlit/core";
import { diffProse } from "@gitlit/diff";
import { countWords, denormalize } from "@gitlit/prose";
import { gitd } from "./gitd-client.js";
import { repos, type RepoRecord } from "./store.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof GitLitError) return reply.status(err.status).send(err.toProblem());
  app.log.error(err);
  return reply.status(500).send({ title: "Internal error", status: 500 });
});

const demoAuthor = { name: "Demo Author", email: "author@example.com", id: "u_demo" };
const mustFind = (owner: string, slug: string): RepoRecord => {
  const r = repos.find(owner, slug);
  if (!r) throw notFound(`Repository ${owner}/${slug}`);
  return r;
};

app.get("/health", async () => ({ ok: true, service: "api" }));

// ----------------------------------------------------------- repositories

app.get("/v1/repositories", async () => ({ repositories: repos.list() }));

app.post("/v1/repositories", async (req, reply) => {
  const body = z.object({
    title: z.string().min(1),
    slug: z.string().regex(/^[a-z0-9-]+$/),
    form: z.enum(["novel", "nonfiction", "memoir", "collection"]),
    genre: z.array(z.string()).default([]),
    targetWords: z.number().int().positive().optional(),
    premise: z.string().optional(),
  }).parse(req.body);

  const id = newRepoId();
  await gitd.createRepo(id);
  const record = repos.create({ id, owner: "demo", ...body });

  await gitd.commit(id, {
    ref: "refs/heads/main",
    message: `Create ${body.title}`,
    author: demoAuthor,
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
  const repo = mustFind(owner, slug);
  const tree = await gitd.tree(repo.id);
  return { ...repo, head: tree.head, files: tree.entries };
});

// ------------------------------------------------------ manuscript content

app.get("/v1/repositories/:owner/:slug/documents", async (req) => {
  const { owner, slug } = req.params as { owner: string; slug: string };
  const repo = mustFind(owner, slug);
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
  const { owner, slug, "*": path } = req.params as Record<string, string>;
  const repo = mustFind(owner, slug);
  const q = z.object({ ref: z.string().default("refs/heads/main"), flow: z.coerce.boolean().default(false) }).parse(req.query);
  const { content } = await gitd.readBlob(repo.id, path!, q.ref);
  if (content === null) throw notFound(path!);
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
  const { owner, slug, "*": path } = req.params as Record<string, string>;
  const repo = mustFind(owner, slug);
  const body = z.object({
    content: z.string(),
    message: z.string().default("Update manuscript"),
    evidence: z.array(z.string()).default([]),
    authoringSessionId: z.string().optional(),
  }).parse(req.body);

  const result = await gitd.commit(repo.id, {
    ref: "refs/heads/main",
    message: body.message,
    author: demoAuthor,
    newTextOrigin: "human_written",
    evidence: body.evidence,
    changes: [{ path, content: body.content }],
  });
  repos.touch(repo.id);
  return result;
});

// -------------------------------------------------------- history & diffs

app.get("/v1/repositories/:owner/:slug/commits", async (req) => {
  const { owner, slug } = req.params as { owner: string; slug: string };
  const repo = mustFind(owner, slug);
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
  const repo = mustFind(owner, slug);
  const q = z.object({ base: z.string(), head: z.string(), path: z.string() }).parse(req.query);
  const [base, head] = await Promise.all([
    gitd.readBlob(repo.id, q.path, q.base),
    gitd.readBlob(repo.id, q.path, q.head),
  ]);
  return diffProse(base.content ?? "", head.content ?? "");
});

app.get("/v1/repositories/:owner/:slug/provenance", async (req) => {
  const { owner, slug } = req.params as { owner: string; slug: string };
  const repo = mustFind(owner, slug);
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

app.post("/v1/repositories/:owner/:slug/sessions", async (req) => {
  const { owner, slug } = req.params as { owner: string; slug: string };
  mustFind(owner, slug);
  const body = z.object({ path: z.string(), client: z.string().default("write_web") }).parse(req.body);
  return { sessionId: newAuthoringSessionId(), path: body.path, startedAt: new Date().toISOString() };
});

/**
 * Aggregates and non-typed input events only. The client never sends a keylog
 * and the server would not store one (§7.5.1).
 */
app.patch("/v1/sessions/:id", async (req) => {
  const body = z.object({
    keystrokes: z.number().int().nonnegative().default(0),
    modeWords: z.record(z.number()).default({}),
    events: z.array(z.object({
      inputMode: z.enum(["pasted", "dictated", "composed", "dropped", "imported", "ai_tool", "synthetic"]),
      charCount: z.number().int(),
      wordCount: z.number().int(),
      contentHash: z.string(),
      isTrusted: z.boolean().default(true),
      occurredAt: z.string(),
    })).default([]),
  }).parse(req.body);
  return { recorded: body.events.length, keystrokes: body.keystrokes };
});

const port = Number(process.env.API_PORT ?? 4000);
app.listen({ port, host: "0.0.0.0" }).catch((e) => { app.log.error(e); process.exit(1); });
