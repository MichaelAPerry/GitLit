import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import {
  advertiseRefs, isService, parseBasicAuth, parseRepoPath, readBody,
  SERVICES, serviceRpc, type Service,
} from "./smart-http.js";
import { parseReceivePackCommands } from "./pkt-line.js";
import { repoPath } from "./repo.js";

/**
 * Where to ask for an authorization decision.
 *
 * In production this must be set. Defaulting to localhost is fine on one
 * machine and wrong everywhere else: deployed, gitd and the API are separate
 * hosts, so the default resolves to gitd itself, every clone fails with a 500,
 * and gitd's own health check stays green throughout. Found by a deploy
 * rehearsal, which is the only place it can be found.
 */
const API_URL = (() => {
  const url = process.env.GITLIT_API_URL;
  if (url) return url;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "GITLIT_API_URL must be set in production. gitd asks the API to authorize " +
        "every clone and push; without it that call resolves to gitd itself and " +
        "all Git access fails while /health still reports ok.",
    );
  }
  return "http://localhost:4000";
})();
const SERVICE_TOKEN = process.env.GITD_SERVICE_TOKEN;

export const isGitRoute = (url: string): boolean =>
  /\/info\/refs(\?|$)|\/git-(upload|receive)-pack(\?|$)/.test(url);

interface Access {
  allowed: boolean;
  reason: string;
  authenticated: boolean;
  repoId?: string;
}

/**
 * Authorization is asked of the API, never decided here (§12.7).
 *
 * gitd owns the volume and speaks the protocol; the API owns who may do what.
 * One authorize() decision then covers a browser request and a `git push`
 * alike, rather than two implementations that drift.
 */
async function checkAccess(
  owner: string, slug: string, capability: "repo:read" | "repo:write", credential?: string,
): Promise<Access> {
  const res = await fetch(`${API_URL}/v1/internal/git-access`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(SERVICE_TOKEN ? { authorization: `Bearer ${SERVICE_TOKEN}` } : {}),
    },
    body: JSON.stringify({ owner, slug, capability, credential }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return { allowed: false, reason: "api_unavailable", authenticated: false };
  return res.json() as Promise<Access>;
}

export function registerSmartHttp(app: FastifyInstance, repoRoot: string): void {
  // Git bodies are binary and must reach us unparsed.
  for (const type of [
    "application/x-git-upload-pack-request",
    "application/x-git-receive-pack-request",
  ]) {
    app.addContentTypeParser(type, (_req, _payload, done) => done(null, undefined));
  }

  /**
   * Basic auth is what git speaks. The password is a GitLit API token; the
   * username is ignored, matching how every other host does this, so an author
   * can paste the token without also remembering which handle it belongs to.
   */
  function credentialFrom(header: string | undefined): string | undefined {
    const basic = parseBasicAuth(header);
    if (!basic) return undefined;
    return basic.password || basic.username;
  }

  const unauthorized = (reply: Parameters<FastifyInstance["get"]>[1] extends never ? never : any) =>
    reply
      .header("www-authenticate", 'Basic realm="GitLit"')
      .status(401)
      .send("Authentication required. Use a GitLit API token as the password.\n");

  app.get("/:owner/:slug/info/refs", async (req, reply) => {
    const parsed = parseRepoPath(req.raw.url ?? "");
    const service = (req.query as { service?: string }).service;
    if (!parsed || !isService(service)) {
      // The dumb-HTTP fallback is not implemented, and pretending otherwise
      // leaves clients retrying a protocol that will never answer.
      return reply.status(400).send("Only the smart HTTP protocol is supported.\n");
    }

    const { capability } = SERVICES[service];
    const access = await checkAccess(parsed.owner, parsed.slug, capability, credentialFrom(req.headers.authorization));

    if (!access.allowed) {
      if (!access.authenticated) return unauthorized(reply);
      // Authenticated but refused: 404 rather than 403, for the same reason
      // the REST surface does it — the existence of a private manuscript is
      // itself sensitive.
      return reply.status(404).send("Repository not found.\n");
    }

    const gitdir = repoPath(repoRoot, access.repoId!);
    if (!fs.existsSync(gitdir)) return reply.status(404).send("Repository not found.\n");

    const { serviceAdvertisement } = await import("./pkt-line.js");
    return advertiseRefs(reply, service, gitdir, serviceAdvertisement(service),
      req.headers["git-protocol"] as string | undefined);
  });

  for (const service of Object.keys(SERVICES) as Service[]) {
    app.post(`/:owner/:slug/${service}`, async (req, reply) => {
      const parsed = parseRepoPath(req.raw.url ?? "");
      if (!parsed) return reply.status(400).send("Bad repository path.\n");

      const { capability } = SERVICES[service];
      const access = await checkAccess(parsed.owner, parsed.slug, capability, credentialFrom(req.headers.authorization));

      if (!access.allowed) {
        if (!access.authenticated) return unauthorized(reply);
        return reply.status(404).send("Repository not found.\n");
      }

      const gitdir = repoPath(repoRoot, access.repoId!);
      if (!fs.existsSync(gitdir)) return reply.status(404).send("Repository not found.\n");

      const body = await readBody(req);

      if (service === "git-receive-pack") {
        const updates = parseReceivePackCommands(body);
        req.log.info(
          { repo: `${parsed.owner}/${parsed.slug}`, refs: updates.map((u) => u.ref) },
          "push received",
        );
      }

      await serviceRpc(reply, service, gitdir, body, req.headers["git-protocol"] as string | undefined);
      return reply;
    });
  }
}
