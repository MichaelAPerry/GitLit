import { newUserId, prefixed } from "@gitlit/core";
import { issueSecret, parseSecret, verifySecret } from "./secrets.js";
import type {
  ApiToken, MagicLink, Principal, Scope, User, WebSession,
} from "./types.js";

const newSessionId = prefixed("sess_web");
const newTokenId = prefixed("tok");
const newLinkId = prefixed("ml");

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;        // 15 minutes

/**
 * Authentication store.
 *
 * No passwords anywhere by design: sign-in is a single-use emailed link, so
 * there is no password to leak, reuse, or hash badly. Authors are not all
 * developers and a forgotten password is the most common way a writer loses
 * access to their own manuscript.
 *
 * IN-MEMORY. Sessions and tokens do not survive a restart yet — the Drizzle
 * tables exist in @gitlit/db and this class is the seam. The security
 * properties (hashing, expiry, single use, scope bounding, constant-time
 * comparison) are real regardless of where the rows live.
 */
export class AuthStore {
  private users = new Map<string, User>();
  private sessions = new Map<string, WebSession>();
  private tokens = new Map<string, ApiToken>();
  private links = new Map<string, MagicLink>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  // ------------------------------------------------------------------ users

  createUser(input: { email: string; handle: string; displayName?: string }): User {
    const email = input.email.trim().toLowerCase();
    if (this.findUserByEmail(email)) {
      throw new Error(`A user already exists for ${email}`);
    }
    if (this.findUserByHandle(input.handle)) {
      throw new Error(`Handle @${input.handle} is taken`);
    }
    const user: User = {
      id: newUserId(),
      email,
      handle: input.handle.toLowerCase(),
      displayName: input.displayName,
      createdAt: this.now().toISOString(),
    };
    this.users.set(user.id, user);
    return user;
  }

  getUser = (id: string): User | undefined => this.users.get(id);
  findUserByEmail = (email: string): User | undefined =>
    [...this.users.values()].find((u) => u.email === email.trim().toLowerCase());
  findUserByHandle = (handle: string): User | undefined =>
    [...this.users.values()].find((u) => u.handle === handle.toLowerCase());

  // ------------------------------------------------------------ magic links

  /** Returns the emailable token. Only its hash is stored. */
  issueMagicLink(email: string): { token: string; link: MagicLink } {
    const issued = issueSecret("glm");
    const link: MagicLink = {
      id: newLinkId(),
      email: email.trim().toLowerCase(),
      selector: issued.selector,
      verifier: issued.verifier,
      expiresAt: new Date(this.now().getTime() + MAGIC_LINK_TTL_MS).toISOString(),
      createdAt: this.now().toISOString(),
    };
    this.links.set(link.selector, link);
    return { token: issued.plaintext, link };
  }

  /**
   * Consume a magic link and start a session. Single use: the link is marked
   * consumed before the session is created, so a replayed link fails even if
   * it arrives concurrently.
   */
  consumeMagicLink(token: string): { user: User; sessionToken: string } | null {
    const parsed = parseSecret(token);
    if (!parsed || parsed.prefix !== "glm") return null;

    const link = this.links.get(parsed.selector);
    if (!link) return null;
    if (link.consumedAt) return null;
    if (new Date(link.expiresAt) <= this.now()) return null;
    if (!verifySecret(parsed.secret, link.verifier)) return null;

    link.consumedAt = this.now().toISOString();

    let user = this.findUserByEmail(link.email);
    if (!user) {
      user = this.createUser({ email: link.email, handle: suggestHandle(link.email, this) });
    }
    user.emailVerifiedAt ??= this.now().toISOString();

    return { user, sessionToken: this.createSession(user.id) };
  }

  // --------------------------------------------------------------- sessions

  createSession(userId: string): string {
    const issued = issueSecret("gls");
    const session: WebSession = {
      id: newSessionId(),
      userId,
      selector: issued.selector,
      verifier: issued.verifier,
      expiresAt: new Date(this.now().getTime() + SESSION_TTL_MS).toISOString(),
      createdAt: this.now().toISOString(),
    };
    this.sessions.set(session.selector, session);
    return issued.plaintext;
  }

  revokeSession(token: string): boolean {
    const parsed = parseSecret(token);
    if (!parsed) return false;
    return this.sessions.delete(parsed.selector);
  }

  revokeAllSessions(userId: string): number {
    let n = 0;
    for (const [selector, s] of this.sessions) {
      if (s.userId === userId) { this.sessions.delete(selector); n++; }
    }
    return n;
  }

  // ----------------------------------------------------------- api tokens

  issueToken(input: {
    userId: string; name: string; scopes: Scope[]; expiresAt?: string;
  }): { token: string; record: ApiToken } {
    const issued = issueSecret("glt");
    const record: ApiToken = {
      id: newTokenId(),
      userId: input.userId,
      name: input.name,
      selector: issued.selector,
      verifier: issued.verifier,
      scopes: [...new Set(input.scopes)],
      expiresAt: input.expiresAt,
      createdAt: this.now().toISOString(),
    };
    this.tokens.set(record.selector, record);
    return { token: issued.plaintext, record };
  }

  listTokens = (userId: string): ApiToken[] =>
    [...this.tokens.values()].filter((t) => t.userId === userId && !t.revokedAt);

  revokeToken(userId: string, tokenId: string): boolean {
    const token = [...this.tokens.values()].find((t) => t.id === tokenId);
    // Scoped to the owner: a token id alone must not let one user revoke another's.
    if (!token || token.userId !== userId || token.revokedAt) return false;
    token.revokedAt = this.now().toISOString();
    return true;
  }

  // ------------------------------------------------------------- resolution

  /**
   * Resolve a credential to a principal, or null.
   *
   * Returns null for every failure mode — unknown, expired, revoked, wrong
   * secret — without distinguishing them to the caller. The reason a
   * credential failed is not the presenter's business.
   */
  resolve(credential: string | undefined | null): Principal | null {
    if (!credential) return null;
    const parsed = parseSecret(credential.trim());
    if (!parsed) return null;

    if (parsed.prefix === "gls") {
      const session = this.sessions.get(parsed.selector);
      if (!session) return null;
      if (new Date(session.expiresAt) <= this.now()) return null;
      if (!verifySecret(parsed.secret, session.verifier)) return null;
      if (!this.users.has(session.userId)) return null;
      // A browser session acts as the full user.
      return {
        userId: session.userId, via: "session", sessionId: session.id,
        scopes: ["profile", "repo:read", "repo:write", "agent:research"],
      };
    }

    if (parsed.prefix === "glt") {
      const token = this.tokens.get(parsed.selector);
      if (!token) return null;
      if (token.revokedAt) return null;
      if (token.expiresAt && new Date(token.expiresAt) <= this.now()) return null;
      if (!verifySecret(parsed.secret, token.verifier)) return null;
      if (!this.users.has(token.userId)) return null;
      token.lastUsedAt = this.now().toISOString();
      return { userId: token.userId, via: "token", tokenId: token.id, scopes: token.scopes };
    }

    return null;
  }
}

function suggestHandle(email: string, store: AuthStore): string {
  const base = (email.split("@")[0] ?? "author").replace(/[^a-z0-9]/gi, "").toLowerCase() || "author";
  if (!store.findUserByHandle(base)) return base;
  for (let i = 2; i < 1000; i++) {
    if (!store.findUserByHandle(`${base}${i}`)) return `${base}${i}`;
  }
  return `${base}${Date.now()}`;
}
