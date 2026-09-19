export type RepoRole = "owner" | "co_author" | "editor" | "beta_reader" | "verifier";
export type Visibility = "private" | "unlisted" | "public";

/** Scopes a programmatic credential may carry. A token can never exceed them. */
export type Scope = "profile" | "repo:read" | "repo:write" | "agent:research";

export const ALL_SCOPES: Scope[] = ["profile", "repo:read", "repo:write", "agent:research"];

export interface User {
  id: string;
  handle: string;
  email: string;
  displayName?: string;
  emailVerifiedAt?: string;
  createdAt: string;
}

export interface WebSession {
  id: string;
  userId: string;
  selector: string;
  verifier: string;
  expiresAt: string;
  createdAt: string;
}

export interface ApiToken {
  id: string;
  userId: string;
  name: string;
  selector: string;
  verifier: string;
  scopes: Scope[];
  expiresAt?: string;
  revokedAt?: string;
  lastUsedAt?: string;
  createdAt: string;
}

export interface MagicLink {
  id: string;
  email: string;
  selector: string;
  verifier: string;
  expiresAt: string;
  consumedAt?: string;
  createdAt: string;
}

/** The resolved caller. `scopes` bounds what a token-authenticated caller may do. */
export interface Principal {
  userId: string;
  via: "session" | "token";
  scopes: Scope[];
  tokenId?: string;
  sessionId?: string;
}
