import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, truncateAll } from "@gitlit/db/testing";
import { AuthStore, MAGIC_LINK_TTL_MS, SESSION_TTL_MS } from "./store.js";
import { PgAuthStore } from "./pg-store.js";
import type { ApiToken, Principal, Scope, User } from "./types.js";

/**
 * One suite, both stores.
 *
 * The in-memory store exists so tests elsewhere stay fast; the Postgres store
 * is what actually runs. Two implementations of the same contract drift
 * silently unless something forces them to agree, so both are held to
 * identical assertions here — and the Postgres side runs against real
 * Postgres, not a mock.
 */
interface AuthContract {
  createUser(i: { email: string; handle: string }): Promise<User>;
  getUser(id: string): Promise<User | undefined>;
  findUserByHandle(h: string): Promise<User | undefined>;
  issueMagicLink(email: string): Promise<{ token: string }>;
  consumeMagicLink(t: string): Promise<{ user: User; sessionToken: string } | null>;
  createSession(userId: string): Promise<string>;
  revokeSession(t: string): Promise<boolean>;
  revokeAllSessions(userId: string): Promise<number>;
  issueToken(i: { userId: string; name: string; scopes: Scope[]; expiresAt?: string }): Promise<{ token: string; record: ApiToken }>;
  listTokens(userId: string): Promise<ApiToken[]>;
  revokeToken(userId: string, id: string): Promise<boolean>;
  resolve(c: string | null | undefined): Promise<Principal | null>;
}

/** The in-memory store is synchronous; awaiting its results costs nothing. */
function wrapMemory(store: AuthStore): AuthContract {
  return {
    createUser: async (i) => store.createUser(i),
    getUser: async (id) => store.getUser(id),
    findUserByHandle: async (h) => store.findUserByHandle(h),
    issueMagicLink: async (e) => store.issueMagicLink(e),
    consumeMagicLink: async (t) => store.consumeMagicLink(t),
    createSession: async (u) => store.createSession(u),
    revokeSession: async (t) => store.revokeSession(t),
    revokeAllSessions: async (u) => store.revokeAllSessions(u),
    issueToken: async (i) => store.issueToken(i),
    listTokens: async (u) => store.listTokens(u),
    revokeToken: async (u, id) => store.revokeToken(u, id),
    resolve: async (c) => store.resolve(c),
  };
}

const suites: {
  name: string;
  setup: () => Promise<{ store: AuthContract; setNow: (d: Date) => void; reset: () => Promise<void>; close: () => Promise<void> }>;
}[] = [
  {
    name: "in-memory",
    setup: async () => {
      let now = new Date("2026-09-20T12:00:00Z");
      let store = new AuthStore(() => now);
      return {
        get store() { return wrapMemory(store); },
        setNow: (d: Date) => { now = d; },
        reset: async () => { now = new Date("2026-09-20T12:00:00Z"); store = new AuthStore(() => now); },
        close: async () => {},
      } as never;
    },
  },
  {
    name: "postgres",
    setup: async () => {
      const { db, client, close } = await createTestDb();
      let now = new Date("2026-09-20T12:00:00Z");
      const store = new PgAuthStore(db, () => now);
      return {
        store: store as unknown as AuthContract,
        setNow: (d: Date) => { now = d; },
        reset: async () => { now = new Date("2026-09-20T12:00:00Z"); await truncateAll(client); },
        close,
      };
    },
  },
];

for (const suite of suites) {
  describe(`AuthStore conformance — ${suite.name}`, () => {
    let ctx: Awaited<ReturnType<typeof suite.setup>>;
    let store: AuthContract;
    const BASE = new Date("2026-09-20T12:00:00Z");

    beforeAll(async () => { ctx = await suite.setup(); });
    beforeEach(async () => { await ctx.reset(); store = ctx.store; });
    afterAll(async () => { await ctx.close(); });

    const advance = (ms: number) => ctx.setNow(new Date(BASE.getTime() + ms));
    const signIn = async (email = "mara@example.com") =>
      (await store.consumeMagicLink((await store.issueMagicLink(email)).token))!;

    describe("magic links", () => {
      it("signs in and creates the user", async () => {
        const r = await signIn();
        expect(r.user.email).toBe("mara@example.com");
        expect(r.user.emailVerifiedAt).toBeTruthy();
        expect(r.sessionToken).toMatch(/^gls_/);
      });

      it("is single use", async () => {
        const { token } = await store.issueMagicLink("mara@example.com");
        expect(await store.consumeMagicLink(token)).not.toBeNull();
        expect(await store.consumeMagicLink(token)).toBeNull();
      });

      it("expires", async () => {
        const { token } = await store.issueMagicLink("mara@example.com");
        advance(MAGIC_LINK_TTL_MS + 1000);
        expect(await store.consumeMagicLink(token)).toBeNull();
      });

      it("rejects a forged secret on a real selector", async () => {
        const { token } = await store.issueMagicLink("mara@example.com");
        const [p, sel] = token.split("_");
        expect(await store.consumeMagicLink(`${p}_${sel}_${"0".repeat(64)}`)).toBeNull();
      });

      it("returns the same user on a second sign-in", async () => {
        const a = await signIn();
        const b = await signIn();
        expect(b.user.id).toBe(a.user.id);
      });

      it("normalises email case", async () => {
        const a = await signIn("Mara@Example.com ");
        const b = await signIn("mara@example.com");
        expect(b.user.id).toBe(a.user.id);
      });

      it("assigns non-colliding handles", async () => {
        const a = await signIn("mara@a.com");
        const b = await signIn("mara@b.com");
        expect(a.user.handle).toBe("mara");
        expect(b.user.handle).toBe("mara2");
      });
    });

    describe("sessions", () => {
      it("resolves with full scopes", async () => {
        const { user, sessionToken } = await signIn();
        const p = (await store.resolve(sessionToken))!;
        expect(p).toMatchObject({ userId: user.id, via: "session" });
        expect(p.scopes).toContain("repo:write");
      });

      it("expires", async () => {
        const { sessionToken } = await signIn();
        advance(SESSION_TTL_MS + 1000);
        expect(await store.resolve(sessionToken)).toBeNull();
      });

      it("can be revoked", async () => {
        const { sessionToken } = await signIn();
        expect(await store.revokeSession(sessionToken)).toBe(true);
        expect(await store.resolve(sessionToken)).toBeNull();
      });

      it("revokes every session for a user", async () => {
        const { user, sessionToken } = await signIn();
        const second = await store.createSession(user.id);
        expect(await store.revokeAllSessions(user.id)).toBe(2);
        expect(await store.resolve(sessionToken)).toBeNull();
        expect(await store.resolve(second)).toBeNull();
      });
    });

    describe("api tokens", () => {
      it("resolves with exactly the granted scopes", async () => {
        const { user } = await signIn();
        const { token } = await store.issueToken({ userId: user.id, name: "cli", scopes: ["repo:read"] });
        const p = (await store.resolve(token))!;
        expect(p.via).toBe("token");
        expect(p.scopes).toEqual(["repo:read"]);
      });

      it("can be revoked", async () => {
        const { user } = await signIn();
        const { token, record } = await store.issueToken({ userId: user.id, name: "cli", scopes: ["repo:read"] });
        expect(await store.revokeToken(user.id, record.id)).toBe(true);
        expect(await store.resolve(token)).toBeNull();
      });

      it("cannot be revoked by another user", async () => {
        const { user } = await signIn("a@example.com");
        const other = await signIn("b@example.com");
        const { token, record } = await store.issueToken({ userId: user.id, name: "cli", scopes: ["repo:read"] });
        expect(await store.revokeToken(other.user.id, record.id)).toBe(false);
        expect(await store.resolve(token)).not.toBeNull();
      });

      it("expires", async () => {
        const { user } = await signIn();
        const { token } = await store.issueToken({
          userId: user.id, name: "short", scopes: ["repo:read"],
          expiresAt: new Date(BASE.getTime() + 1000).toISOString(),
        });
        advance(2000);
        expect(await store.resolve(token)).toBeNull();
      });

      it("omits revoked tokens from the listing", async () => {
        const { user } = await signIn();
        const { record } = await store.issueToken({ userId: user.id, name: "cli", scopes: ["repo:read"] });
        await store.revokeToken(user.id, record.id);
        expect(await store.listTokens(user.id)).toHaveLength(0);
      });

      it("deduplicates scopes", async () => {
        const { user } = await signIn();
        const { record } = await store.issueToken({
          userId: user.id, name: "cli", scopes: ["repo:read", "repo:read", "repo:write"],
        });
        expect(record.scopes).toEqual(["repo:read", "repo:write"]);
      });
    });

    describe("resolve", () => {
      it("rejects junk without distinguishing failure modes", async () => {
        for (const bad of ["", "   ", "nope", `glt_${"a".repeat(18)}_${"b".repeat(64)}`, "bearer abc"]) {
          expect(await store.resolve(bad), bad).toBeNull();
        }
      });
      it("rejects null and undefined", async () => {
        expect(await store.resolve(null)).toBeNull();
        expect(await store.resolve(undefined)).toBeNull();
      });
    });
  });
}
