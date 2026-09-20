import { spawn } from "node:child_process";
import { createGunzip } from "node:zlib";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";

/**
 * Smart HTTP transport (§12.7).
 *
 * The protocol itself is handled by git's own `upload-pack` and
 * `receive-pack` in `--stateless-rpc` mode — the same approach Gitea and
 * GitLab take. Reimplementing pack negotiation in TypeScript would be a large
 * amount of subtle code to own for no gain; what is worth owning is the layer
 * around it: who may do this, and what the server believes about what arrived.
 */

export type Service = "git-upload-pack" | "git-receive-pack";

export const SERVICES: Record<Service, { capability: "repo:read" | "repo:write" }> = {
  "git-upload-pack": { capability: "repo:read" },   // clone / fetch
  "git-receive-pack": { capability: "repo:write" }, // push
};

export function isService(value: string | undefined): value is Service {
  return value === "git-upload-pack" || value === "git-receive-pack";
}

/**
 * Protocol version is the client's choice, announced in the Git-Protocol
 * header. Forcing v2 server-side breaks v0 clients, and the header is the only
 * client-supplied value allowed through — narrowed to the exact shape git
 * sends so nothing else can be smuggled into the child's environment.
 */
function run(service: Service, args: string[], gitdir: string, protocol?: string) {
  const safeProtocol = protocol && /^version=[0-9]$/.test(protocol) ? protocol : undefined;
  return spawn("git", [service.replace("git-", ""), ...args, gitdir], {
    env: {
      ...process.env,
      ...(safeProtocol ? { GIT_PROTOCOL: safeProtocol } : {}),
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

/** `GET /:owner/:slug.git/info/refs?service=…` — the ref advertisement. */
export async function advertiseRefs(
  reply: FastifyReply, service: Service, gitdir: string, banner: Buffer, protocol?: string,
): Promise<void> {
  const child = run(service, ["--stateless-rpc", "--advertise-refs"], gitdir, protocol);
  const chunks: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => chunks.push(c));

  const stderr: Buffer[] = [];
  child.stderr.on("data", (c: Buffer) => stderr.push(c));

  const code = await new Promise<number>((resolve) => child.on("close", resolve));
  if (code !== 0) {
    await reply.status(500).send(
      `GitLit could not read this repository.\n${Buffer.concat(stderr).toString("utf8")}`,
    );
    return;
  }

  await reply
    .header("content-type", `application/x-${service}-advertisement`)
    .header("cache-control", "no-cache, max-age=0, must-revalidate")
    .send(Buffer.concat([banner, ...chunks]));
}

/** Request bodies may arrive gzipped; git does this for large fetches. */
export async function readBody(req: FastifyRequest): Promise<Buffer> {
  const raw = req.raw;
  const stream = req.headers["content-encoding"] === "gzip" ? raw.pipe(createGunzip()) : raw;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * `POST /:owner/:slug.git/:service` — the actual pack exchange.
 *
 * The body is read fully rather than streamed straight through because
 * receive-pack's ref updates have to be parsed before the push is accepted
 * (§12.7). Manuscripts are text and pushes are small; the memory cost is not
 * comparable to a source-code host's.
 */
export async function serviceRpc(
  reply: FastifyReply, service: Service, gitdir: string, body: Buffer, protocol?: string,
): Promise<{ stdout: Buffer; code: number }> {
  const child = run(service, ["--stateless-rpc"], gitdir, protocol);
  const chunks: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => chunks.push(c));
  const stderr: Buffer[] = [];
  child.stderr.on("data", (c: Buffer) => stderr.push(c));

  Readable.from([body]).pipe(child.stdin);
  const code = await new Promise<number>((resolve) => child.on("close", resolve));
  const stdout = Buffer.concat(chunks);

  if (!reply.sent) {
    await reply
      .header("content-type", `application/x-${service}-result`)
      .header("cache-control", "no-cache, max-age=0, must-revalidate")
      .send(stdout);
  }
  return { stdout, code };
}

/** Parse `owner/slug.git` out of a wildcard path. */
export function parseRepoPath(url: string): { owner: string; slug: string } | null {
  // The URL arrives with its query string ("…/info/refs?service=…"), so strip
  // that before matching rather than anchoring against it.
  const path = url.split("?")[0] ?? "";
  const match = /^\/?([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+?)(?:\.git)?\/(?:info\/refs|git-[a-z-]+)$/.exec(path);
  if (!match) return null;
  return { owner: match[1]!.toLowerCase(), slug: match[2]!.toLowerCase() };
}

export interface BasicCredential { username: string; password: string }

export function parseBasicAuth(header: string | undefined): BasicCredential | null {
  if (!header?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}
