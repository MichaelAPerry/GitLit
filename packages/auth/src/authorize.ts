import { anonymousGrants, roleGrants, type Capability } from "./permissions.js";
import type { Principal, RepoRole, Scope, Visibility } from "./types.js";

/**
 * The single authorization decision point.
 *
 * Every route calls this. Scattering `if (user.id === repo.ownerId)` through
 * handlers is how authorization bugs happen: one forgotten check is a breach,
 * and forgotten checks are invisible in review. One function is exhaustively
 * testable, and a new route that forgets to call it fails closed because it
 * has no principal to act on.
 */

export interface AccessRequest {
  principal: Principal | null;
  capability: Capability;
  repo: {
    id: string;
    ownerUserId?: string | null;
    visibility: Visibility;
  };
  /** Explicit collaborator grants for this repo. */
  collaborators?: { userId: string; role: RepoRole }[];
}

export interface AccessDecision {
  allowed: boolean;
  /** For logs and problem details. Never leaks WHY to an anonymous caller. */
  reason:
    | "owner" | "collaborator" | "public_read"
    | "anonymous" | "not_a_collaborator" | "role_insufficient" | "scope_insufficient";
  role?: RepoRole;
}

/**
 * The scope a credential must carry for each capability.
 *
 * `agent:research` is separate from `repo:write` on purpose. An MCP token
 * carries agent:research and NOT repo:write, so even if the path allowlist in
 * the commit tool were bypassed, the credential still cannot author prose.
 * Scope and allowlist are independent layers over the same rule (§8.3).
 */
const REQUIRED_SCOPE: Record<Capability, Scope> = {
  "repo:read": "repo:read",
  "repo:provenance": "repo:read",
  "repo:write": "repo:write",
  "repo:admin": "repo:write",
  "agent:research": "agent:research",
};

export function authorize(req: AccessRequest): AccessDecision {
  const { principal, capability, repo } = req;

  if (!principal) {
    return anonymousGrants(repo.visibility, capability)
      ? { allowed: true, reason: "public_read" }
      : { allowed: false, reason: "anonymous" };
  }

  // A token can never exceed its scopes, whatever the user's role. Checked
  // before the role so a broadly-privileged owner cannot widen a narrow token.
  if (!principal.scopes.includes(REQUIRED_SCOPE[capability])) {
    return { allowed: false, reason: "scope_insufficient" };
  }

  const role = resolveRole(principal.userId, repo, req.collaborators);
  if (!role) {
    // A signed-in stranger gets exactly what an anonymous visitor gets.
    return anonymousGrants(repo.visibility, capability)
      ? { allowed: true, reason: "public_read" }
      : { allowed: false, reason: "not_a_collaborator" };
  }

  if (!roleGrants(role, capability)) {
    return { allowed: false, reason: "role_insufficient", role };
  }

  return { allowed: true, reason: role === "owner" ? "owner" : "collaborator", role };
}

function resolveRole(
  userId: string,
  repo: AccessRequest["repo"],
  collaborators: AccessRequest["collaborators"],
): RepoRole | null {
  if (repo.ownerUserId && repo.ownerUserId === userId) return "owner";
  return collaborators?.find((c) => c.userId === userId)?.role ?? null;
}
