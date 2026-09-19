import Fastify from "fastify";
import { z } from "zod";
import { GitLitError } from "@gitlit/core";
import { generateSigningKey } from "@gitlit/provenance";
import { initRepo, readFileAt, repoPath, log, resolveHead, listTree } from "./repo.js";
import { writeCommit } from "./commit-path.js";

const REPO_ROOT = process.env.REPO_ROOT ?? "./repos";

/**
 * gitd is the only process that touches the repository volume (§5). Keeping
 * the commit path in exactly one service is what makes the provenance model
 * auditable — there is a single place where spans can be written.
 */
export function buildServer() {
  const app = Fastify({ logger: true });

  // Dev-only in-memory key store. Production wraps these with KMS (§14).
  const keys = new Map<string, ReturnType<typeof generateSigningKey>>();
  const keyFor = (repoId: string) => {
    let k = keys.get(repoId);
    if (!k) { k = generateSigningKey(`key_${repoId}`); keys.set(repoId, k); }
    return k;
  };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof GitLitError) return reply.status(err.status).send(err.toProblem());
    app.log.error(err);
    return reply.status(500).send({ title: "Internal error", status: 500 });
  });

  app.get("/health", async () => ({ ok: true, service: "gitd" }));

  app.post("/repos", async (req) => {
    const body = z.object({ repoId: z.string(), defaultBranch: z.string().default("main") }).parse(req.body);
    const gitdir = repoPath(REPO_ROOT, body.repoId);
    await initRepo(gitdir, body.defaultBranch);
    return { gitdir, publicKey: keyFor(body.repoId).publicKey };
  });

  app.get("/repos/:repoId/blob", async (req) => {
    const { repoId } = req.params as { repoId: string };
    const q = z.object({ ref: z.string().default("refs/heads/main"), path: z.string() }).parse(req.query);
    const content = await readFileAt(repoPath(REPO_ROOT, repoId), q.ref, q.path);
    return { path: q.path, content };
  });

  app.get("/repos/:repoId/tree", async (req) => {
    const { repoId } = req.params as { repoId: string };
    const q = z.object({ ref: z.string().default("refs/heads/main") }).parse(req.query);
    const gitdir = repoPath(REPO_ROOT, repoId);
    const head = await resolveHead(gitdir, q.ref);
    if (!head) return { head: null, entries: [] };
    return { head, entries: [...(await listTree(gitdir, head)).keys()].sort() };
  });

  app.get("/repos/:repoId/log", async (req) => {
    const { repoId } = req.params as { repoId: string };
    const q = z.object({ ref: z.string().default("refs/heads/main"), depth: z.coerce.number().default(50) }).parse(req.query);
    const entries = await log(repoPath(REPO_ROOT, repoId), q.ref, q.depth);
    return entries.map((e) => ({
      sha: e.oid,
      message: e.commit.message,
      author: e.commit.author.name,
      committedAt: new Date(e.commit.author.timestamp * 1000).toISOString(),
      parents: e.commit.parent,
    }));
  });

  /**
   * The write path. Callers say how text arrived (`newTextOrigin`); what
   * survives from the parent is recomputed here. A client can never assert
   * its own provenance class (§7.2).
   */
  app.post("/repos/:repoId/commit", async (req) => {
    const { repoId } = req.params as { repoId: string };
    const body = z.object({
      ref: z.string().default("refs/heads/main"),
      message: z.string().min(1),
      author: z.object({ name: z.string(), email: z.string(), id: z.string().optional() }),
      changes: z.array(z.object({ path: z.string(), content: z.string().nullable() })).min(1),
      newTextOrigin: z.enum([
        "ai_generated", "ai_assisted", "human_edited_ai", "human_written", "imported", "unknown",
      ]),
      agentSessionId: z.string().optional(),
      declaredModel: z.string().optional(),
      evidence: z.array(z.string()).default([]),
    }).parse(req.body);

    return writeCommit({
      gitdir: repoPath(REPO_ROOT, repoId),
      repoId,
      signingKey: keyFor(repoId),
      ...body,
    });
  });

  return app;
}

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("index.js")) {
  const app = buildServer();
  const port = Number(process.env.GITD_PORT ?? 4001);
  app.listen({ port, host: "0.0.0.0" }).catch((e) => { app.log.error(e); process.exit(1); });
}
