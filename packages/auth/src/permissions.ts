import type { RepoRole, Visibility } from "./types.js";

/**
 * The capability matrix (§11.2).
 *
 * Roles are deliberately narrow. `beta_reader` and `verifier` exist because a
 * publisher checking provenance and a friend reading a draft need access
 * without any ability to alter the manuscript — and a provenance system whose
 * reviewers can edit the thing they are attesting to is worthless.
 */
export type Capability =
  | "repo:read"        // read manuscript content
  | "repo:write"       // commit changes to the manuscript
  | "repo:admin"       // settings, collaborators, deletion
  | "repo:provenance"  // read the provenance record and receipts
  | "agent:research";  // run an MCP research session against the repo

const ROLE_CAPABILITIES: Record<RepoRole, Capability[]> = {
  owner:     ["repo:read", "repo:write", "repo:admin", "repo:provenance", "agent:research"],
  co_author: ["repo:read", "repo:write", "repo:provenance", "agent:research"],
  editor:    ["repo:read", "repo:write", "repo:provenance"],
  beta_reader: ["repo:read"],
  verifier:  ["repo:provenance"],
};

export function roleGrants(role: RepoRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role]?.includes(capability) ?? false;
}

/**
 * What an unauthenticated visitor may do, by repo visibility.
 *
 * `unlisted` and `public` differ only in discovery (§16.2 rung 3): both are
 * readable by link, neither is writable, and neither exposes provenance to
 * anonymous callers — that goes through a verification link with its own
 * token, so views can be counted and revoked.
 */
export function anonymousGrants(visibility: Visibility, capability: Capability): boolean {
  if (capability !== "repo:read") return false;
  return visibility === "public" || visibility === "unlisted";
}
