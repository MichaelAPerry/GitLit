import type { FastifyReply, FastifyRequest } from "fastify";
import { PgAuthStore, authorize, type Capability, type Principal } from "@gitlit/auth";
import { forbidden, GitLitError } from "@gitlit/core";
import type { RepoRecord } from "./repos.js";

import { db } from "./db.js";

/** Lazily bound so the database is initialised before first use. */
let store: PgAuthStore | null = null;
export const auth = new Proxy({} as PgAuthStore, {
  get(_t, prop) {
    store ??= new PgAuthStore(db());
    return Reflect.get(store, prop, store);
  },
});

export const SESSION_COOKIE = "gitlit_session";

declare module "fastify" {
  interface FastifyRequest { principal: Principal | null }
}

/** Bearer header first, then the session cookie. */
export async function resolvePrincipal(req: FastifyRequest): Promise<Principal | null> {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const p = await auth.resolve(header.slice(7).trim());
    if (p) return p;
  }
  const cookie = req.headers.cookie
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  return auth.resolve(cookie ? decodeURIComponent(cookie) : null);
}

export function requireUser(req: FastifyRequest): Principal {
  if (!req.principal) {
    throw new GitLitError("unauthenticated", 401, "Sign in required", "You are not signed in.");
  }
  return req.principal;
}

/**
 * Gate a repository action.
 *
 * Deliberately returns 404 rather than 403 when the caller cannot even read
 * the repo: telling an unauthorised stranger that `mara/secret-novel` exists
 * leaks the fact that an author is writing it, which for an unpublished
 * manuscript is itself sensitive.
 */
export function requireAccess(
  req: FastifyRequest, repo: RepoRecord, capability: Capability,
): void {
  const decision = authorize({
    principal: req.principal,
    capability,
    repo: { id: repo.id, ownerUserId: repo.ownerUserId, visibility: repo.visibility },
    collaborators: repo.collaborators,
  });
  if (decision.allowed) return;

  const canRead = authorize({
    principal: req.principal,
    capability: "repo:read",
    repo: { id: repo.id, ownerUserId: repo.ownerUserId, visibility: repo.visibility },
    collaborators: repo.collaborators,
  }).allowed;

  if (!canRead) {
    throw new GitLitError("not-found", 404, "Not found", `Repository ${repo.owner}/${repo.slug} not found`);
  }

  // Denied, but the repo is readable. If nobody is signed in, signing in could
  // succeed — say 401 so the client prompts for it rather than 403, which
  // tells a browser the action is hopeless.
  if (!req.principal) {
    throw new GitLitError("unauthenticated", 401, "Sign in required", "Sign in to do that.");
  }

  throw forbidden(
    decision.reason === "scope_insufficient"
      ? "This credential does not carry the scope required for that action."
      : "Your role on this book does not permit that action.",
  );
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  const secure = process.env.NODE_ENV === "production";
  reply.header(
    "set-cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 3600}` +
      (secure ? "; Secure" : ""),
  );
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.header("set-cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}
