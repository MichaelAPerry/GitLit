import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { GitLitError, constantTimeEquals } from "@gitlit/core";
import { initMonitoring, reportError } from "@gitlit/observability";
import { initRepo, readFileAt, repoPath, log, resolveHead, listTree } from "./repo.js";
import { writeCommit } from "./commit-path.js";
import { KeyStore } from "./keystore.js";
import { isGitRoute, registerSmartHttp } from "./git-routes.js";
import { gitdState } from "./operator.js";

const REPO_ROOT = process.env.REPO_ROOT ?? "./repos";

/** Off without SENTRY_DSN. Everything sent is scrubbed first (§2.5). */
const monitoringOn = initMonitoring({ service: "gitd" });

/**
 * gitd is the only process that touches the repository volume (§5). Keeping
 * the commit path in exactly one service is what makes the provenance model
 * auditable — there is a single place where spans can be written.
 */
export function buildServer() {
  const app = Fastify({ logger: true });

  // Keys are persisted beside each repo and survive restarts (§7.4). An
  // in-memory store here would make every receipt unverifiable after a
  // restart, which is the opposite of what receipts are for.
  const keys = new KeyStore((repoId) => repoPath(REPO_ROOT, repoId));
  const keyFor = (repoId: string) => keys.for(repoId);

  /**
   * Service authentication.
   *
   * gitd holds every repository and the commit path that writes provenance.
   * If it is reachable without a credential, authorization in the API is
   * decorative — anyone who can route to this port can commit as anyone. It is
   * an internal service, so a shared secret is the right shape; it must be set
   * explicitly rather than defaulted, so a misconfigured deploy fails loudly
   * instead of silently running open.
   */
  const serviceToken = process.env.GITD_SERVICE_TOKEN;
  if (!serviceToken) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("GITD_SERVICE_TOKEN must be set. Refusing to start without service auth.");
    }
    app.log.warn("GITD_SERVICE_TOKEN is unset — running OPEN. Never do this outside development.");
  }

  app.addHook("onRequest", async (req, reply) => {
    // Git transport routes authenticate the end user themselves, against the
    // API, rather than with the internal service token.
    // The operator surface carries its own credential (OPERATOR_TOKEN) so that
    // preflight needs one token rather than a different one per service.
    if (req.url === "/health" || req.url === "/operator/state" || isGitRoute(req.url) || !serviceToken) return;
    const header = req.headers.authorization;
    const presented = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const a = Buffer.from(presented);
    const b = Buffer.from(serviceToken);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (!ok) {
      await reply.status(401).send({ title: "Unauthorized", status: 401, detail: "gitd requires a service token." });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof GitLitError) return reply.status(err.status).send(err.toProblem());
    app.log.error(err);
    /**
     * The route, not the URL: a Git request path carries the owner and slug
     * of a private manuscript, and a repository's existence is itself the
     * thing authorization is protecting.
     */
    reportError(err, { route: _req.routeOptions?.url, method: _req.method });
    return reply.status(500).send({ title: "Internal error", status: 500 });
  });

  /**
   * The machine id is here so preflight can tell whether more than one gitd is
   * answering — the failure that silently splits the manuscripts across two
   * disks. It identifies a machine, not a person, and Fly exposes it anyway.
   */
  app.get("/health", async () => ({
    ok: true, service: "gitd", monitoring: monitoringOn,
    machine: process.env.FLY_MACHINE_ID ?? process.env.HOSTNAME ?? "local",
  }));

  /**
   * Operator surface: whether the signing keys are encrypted and whether the
   * newest backup actually restores. Only gitd can answer either.
   *
   * Behind the service token, which the operator already holds — this reports
   * where the deployment is weak, which is a useful list for the wrong reader.
   */
  app.get("/operator/state", async (req) => {
    const expected = process.env.OPERATOR_TOKEN;
    const header = req.headers.authorization;
    const presented = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!expected || !presented || !constantTimeEquals(expected, presented)) {
      throw new GitLitError("forbidden", 403, "Forbidden", "Operator access is not available.");
    }
    return gitdState(REPO_ROOT);
  });

  registerSmartHttp(app, REPO_ROOT);

  app.post("/repos", async (req) => {
    const body = z.object({ repoId: z.string(), defaultBranch: z.string().default("main") }).parse(req.body);
    const gitdir = repoPath(REPO_ROOT, body.repoId);
    await initRepo(gitdir, body.defaultBranch);
    return { gitdir, publicKey: keyFor(body.repoId).publicKey };
  });

  app.get("/repos/:repoId/public-key", async (req) => {
    const { repoId } = req.params as { repoId: string };
    return { keyId: keyFor(repoId).keyId, publicKey: keys.publicKey(repoId) };
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
