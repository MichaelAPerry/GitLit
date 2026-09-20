import { and, eq, lt, or, isNull } from "drizzle-orm";
import { schema, type Database } from "@gitlit/db";
import { newUserId, prefixed } from "@gitlit/core";
import { issueSecret, parseSecret, verifySecret } from "./secrets.js";
import { MAGIC_LINK_TTL_MS, SESSION_TTL_MS } from "./store.js";
import type { ApiToken, Principal, Scope, User } from "./types.js";

const newSessionId = prefixed("sess_web");
const newTokenId = prefixed("tok");
const newLinkId = prefixed("ml");

/**
 * Postgres-backed authentication (§11.1).
 *
 * Users, sessions and tokens are the one part of GitLit that is NOT an index
 * over Git (§2.3) — they are primary data with no other source of truth, so
 * losing them loses real state rather than something a reindex could rebuild.
 * That is why persistence matters more here than for repository metadata.
 *
 * Behaviour matches the in-memory AuthStore exactly; the same test suite runs
 * against both, so the two cannot drift.
 */
export class PgAuthStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ------------------------------------------------------------------ users

  async createUser(input: { email: string; handle: string; displayName?: string }): Promise<User> {
    const email = input.email.trim().toLowerCase();
    const handle = input.handle.toLowerCase();
    const [row] = await this.db.insert(schema.users).values({
      id: newUserId(), email, handle, displayName: input.displayName,
    }).returning();
    return toUser(row!);
  }

  async getUser(id: string): Promise<User | undefined> {
    const [row] = await this.db.select().from(schema.users).where(eq(schema.users.id, id));
    return row ? toUser(row) : undefined;
  }

  async findUserByEmail(email: string): Promise<User | undefined> {
    const [row] = await this.db.select().from(schema.users)
      .where(eq(schema.users.email, email.trim().toLowerCase()));
    return row ? toUser(row) : undefined;
  }

  async findUserByHandle(handle: string): Promise<User | undefined> {
    const [row] = await this.db.select().from(schema.users)
      .where(eq(schema.users.handle, handle.toLowerCase()));
    return row ? toUser(row) : undefined;
  }

  // ------------------------------------------------------------ magic links

  async issueMagicLink(email: string): Promise<{ token: string }> {
    const issued = issueSecret("glm");
    await this.db.insert(schema.magicLinks).values({
      id: newLinkId(),
      email: email.trim().toLowerCase(),
      selector: issued.selector,
      verifier: issued.verifier,
      expiresAt: new Date(this.now().getTime() + MAGIC_LINK_TTL_MS),
    });
    return { token: issued.plaintext };
  }

  async consumeMagicLink(token: string): Promise<{ user: User; sessionToken: string } | null> {
    const parsed = parseSecret(token);
    if (!parsed || parsed.prefix !== "glm") return null;

    /**
     * Mark consumed in the same statement that checks it is unconsumed. A
     * read-then-write would let two concurrent redemptions of one link both
     * see it unused; the UPDATE ... WHERE consumed_at IS NULL RETURNING makes
     * exactly one of them win.
     */
    const [link] = await this.db.update(schema.magicLinks)
      .set({ consumedAt: this.now() })
      .where(and(
        eq(schema.magicLinks.selector, parsed.selector),
        isNull(schema.magicLinks.consumedAt),
      ))
      .returning();

    if (!link) return null;
    if (new Date(link.expiresAt) <= this.now()) return null;
    if (!verifySecret(parsed.secret, link.verifier)) return null;

    let user = await this.findUserByEmail(link.email);
    if (!user) {
      user = await this.createUser({ email: link.email, handle: await this.suggestHandle(link.email) });
    }
    if (!user.emailVerifiedAt) {
      await this.db.update(schema.users)
        .set({ emailVerified: this.now() })
        .where(eq(schema.users.id, user.id));
      user = (await this.getUser(user.id))!;
    }
    return { user, sessionToken: await this.createSession(user.id) };
  }

  // --------------------------------------------------------------- sessions

  async createSession(userId: string): Promise<string> {
    const issued = issueSecret("gls");
    await this.db.insert(schema.sessions).values({
      id: newSessionId(), userId,
      selector: issued.selector, verifier: issued.verifier,
      expiresAt: new Date(this.now().getTime() + SESSION_TTL_MS),
    });
    return issued.plaintext;
  }

  async revokeSession(token: string): Promise<boolean> {
    const parsed = parseSecret(token);
    if (!parsed) return false;
    const deleted = await this.db.delete(schema.sessions)
      .where(eq(schema.sessions.selector, parsed.selector)).returning();
    return deleted.length > 0;
  }

  async revokeAllSessions(userId: string): Promise<number> {
    const deleted = await this.db.delete(schema.sessions)
      .where(eq(schema.sessions.userId, userId)).returning();
    return deleted.length;
  }

  /** Housekeeping: expired rows are dead weight and a small disclosure risk. */
  async purgeExpired(): Promise<{ sessions: number; magicLinks: number }> {
    const now = this.now();
    const sessions = await this.db.delete(schema.sessions)
      .where(lt(schema.sessions.expiresAt, now)).returning();
    const links = await this.db.delete(schema.magicLinks)
      .where(or(lt(schema.magicLinks.expiresAt, now))).returning();
    return { sessions: sessions.length, magicLinks: links.length };
  }

  // ------------------------------------------------------------- api tokens

  async issueToken(input: {
    userId: string; name: string; scopes: Scope[]; expiresAt?: string;
  }): Promise<{ token: string; record: ApiToken }> {
    const issued = issueSecret("glt");
    const [row] = await this.db.insert(schema.apiTokens).values({
      id: newTokenId(),
      userId: input.userId,
      name: input.name,
      selector: issued.selector,
      verifier: issued.verifier,
      scopes: [...new Set(input.scopes)],
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
    }).returning();
    return { token: issued.plaintext, record: toToken(row!) };
  }

  async listTokens(userId: string): Promise<ApiToken[]> {
    const rows = await this.db.select().from(schema.apiTokens)
      .where(and(eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt)));
    return rows.map(toToken);
  }

  async revokeToken(userId: string, tokenId: string): Promise<boolean> {
    // Scoped to the owner in the WHERE clause, so a token id alone can never
    // revoke someone else's credential.
    const updated = await this.db.update(schema.apiTokens)
      .set({ revokedAt: this.now() })
      .where(and(
        eq(schema.apiTokens.id, tokenId),
        eq(schema.apiTokens.userId, userId),
        isNull(schema.apiTokens.revokedAt),
      ))
      .returning();
    return updated.length > 0;
  }

  // ------------------------------------------------------------- resolution

  async resolve(credential: string | undefined | null): Promise<Principal | null> {
    if (!credential) return null;
    const parsed = parseSecret(credential.trim());
    if (!parsed) return null;

    if (parsed.prefix === "gls") {
      const [session] = await this.db.select().from(schema.sessions)
        .where(eq(schema.sessions.selector, parsed.selector));
      if (!session) return null;
      if (new Date(session.expiresAt) <= this.now()) return null;
      if (!verifySecret(parsed.secret, session.verifier)) return null;
      return {
        userId: session.userId, via: "session", sessionId: session.id,
        scopes: ["profile", "repo:read", "repo:write", "agent:research"],
      };
    }

    if (parsed.prefix === "glt") {
      const [token] = await this.db.select().from(schema.apiTokens)
        .where(eq(schema.apiTokens.selector, parsed.selector));
      if (!token) return null;
      if (token.revokedAt) return null;
      if (token.expiresAt && new Date(token.expiresAt) <= this.now()) return null;
      if (!verifySecret(parsed.secret, token.verifier)) return null;
      await this.db.update(schema.apiTokens)
        .set({ lastUsedAt: this.now() })
        .where(eq(schema.apiTokens.id, token.id));
      return {
        userId: token.userId, via: "token", tokenId: token.id,
        scopes: token.scopes as Scope[],
      };
    }

    return null;
  }

  private async suggestHandle(email: string): Promise<string> {
    const base = (email.split("@")[0] ?? "author").replace(/[^a-z0-9]/gi, "").toLowerCase() || "author";
    if (!(await this.findUserByHandle(base))) return base;
    for (let i = 2; i < 1000; i++) {
      if (!(await this.findUserByHandle(`${base}${i}`))) return `${base}${i}`;
    }
    return `${base}${Date.now()}`;
  }
}

type UserRow = typeof schema.users.$inferSelect;
type TokenRow = typeof schema.apiTokens.$inferSelect;

const toUser = (r: UserRow): User => ({
  id: r.id,
  handle: r.handle,
  email: r.email,
  displayName: r.displayName ?? undefined,
  emailVerifiedAt: r.emailVerified?.toISOString(),
  createdAt: r.createdAt.toISOString(),
});

const toToken = (r: TokenRow): ApiToken => ({
  id: r.id,
  userId: r.userId,
  name: r.name,
  selector: r.selector,
  verifier: r.verifier,
  scopes: r.scopes as Scope[],
  expiresAt: r.expiresAt?.toISOString(),
  revokedAt: r.revokedAt?.toISOString(),
  lastUsedAt: r.lastUsedAt?.toISOString(),
  createdAt: r.createdAt.toISOString(),
});
