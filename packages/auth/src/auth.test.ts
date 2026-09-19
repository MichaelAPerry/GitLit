import { describe, expect, it, beforeEach } from "vitest";
import { AuthStore, MAGIC_LINK_TTL_MS, SESSION_TTL_MS } from "./store.js";
import { issueSecret, parseSecret, verifySecret, hashSecret } from "./secrets.js";
import { authorize } from "./authorize.js";
import { roleGrants, anonymousGrants } from "./permissions.js";
import type { Principal, RepoRole, Scope } from "./types.js";

// ---------------------------------------------------------------- secrets

describe("secrets", () => {
  it("never returns the plaintext in the stored verifier", () => {
    const { plaintext, verifier } = issueSecret("glt");
    expect(verifier).not.toContain(plaintext);
    expect(plaintext).not.toContain(verifier);
  });

  it("stores a hash, not the secret", () => {
    const { plaintext, verifier } = issueSecret("glt");
    const secret = plaintext.split("_")[2]!;
    expect(verifier).toBe(hashSecret(secret));
    expect(verifier).not.toBe(secret);
  });

  it("produces unique credentials", () => {
    const seen = new Set(Array.from({ length: 500 }, () => issueSecret("glt").plaintext));
    expect(seen.size).toBe(500);
  });

  it("uses a three-part format so lookup is by selector, not by secret", () => {
    const parsed = parseSecret(issueSecret("glt").plaintext)!;
    expect(parsed.prefix).toBe("glt");
    expect(parsed.selector).toBeTruthy();
    expect(parsed.secret).toBeTruthy();
  });

  // Regression: the payload encoding must not contain the delimiter. base64url
  // includes "_", which made a fraction of tokens unparseable.
  it("always round-trips, across many issued credentials", () => {
    for (let i = 0; i < 2000; i++) {
      const { plaintext, selector, verifier } = issueSecret("glt");
      const parsed = parseSecret(plaintext);
      expect(parsed, plaintext).not.toBeNull();
      expect(parsed!.selector).toBe(selector);
      expect(verifySecret(parsed!.secret, verifier)).toBe(true);
    }
  });

  it("never emits the delimiter inside a payload", () => {
    for (let i = 0; i < 200; i++) {
      const { selector, plaintext } = issueSecret("glt");
      expect(selector).not.toContain("_");
      expect(plaintext.split("_")).toHaveLength(3);
    }
  });

  it("rejects malformed credentials", () => {
    for (const bad of ["", "nope", "glt_only-two", "a_b_c_d"]) {
      expect(parseSecret(bad), bad).toBeNull();
    }
  });

  it("verifies a correct secret and rejects a wrong one", () => {
    const { plaintext, verifier } = issueSecret("glt");
    const secret = plaintext.split("_")[2]!;
    expect(verifySecret(secret, verifier)).toBe(true);
    expect(verifySecret("wrong", verifier)).toBe(false);
  });

  it("rejects a truncated secret rather than matching a prefix", () => {
    const { plaintext, verifier } = issueSecret("glt");
    const secret = plaintext.split("_")[2]!;
    expect(verifySecret(secret.slice(0, -1), verifier)).toBe(false);
  });
});

// --------------------------------------------------------------- auth store

describe("AuthStore", () => {
  let clock: Date;
  let store: AuthStore;
  beforeEach(() => {
    clock = new Date("2026-09-19T12:00:00Z");
    store = new AuthStore(() => clock);
  });
  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };

  describe("magic links", () => {
    it("signs in and creates the user on first use", () => {
      const { token } = store.issueMagicLink("mara@example.com");
      const result = store.consumeMagicLink(token)!;
      expect(result.user.email).toBe("mara@example.com");
      expect(result.user.emailVerifiedAt).toBeTruthy();
      expect(result.sessionToken).toMatch(/^gls_/);
    });

    it("is SINGLE USE — a replayed link fails", () => {
      const { token } = store.issueMagicLink("mara@example.com");
      expect(store.consumeMagicLink(token)).not.toBeNull();
      expect(store.consumeMagicLink(token)).toBeNull();
    });

    it("expires", () => {
      const { token } = store.issueMagicLink("mara@example.com");
      advance(MAGIC_LINK_TTL_MS + 1000);
      expect(store.consumeMagicLink(token)).toBeNull();
    });

    it("rejects a forged token with a valid selector", () => {
      const { token } = store.issueMagicLink("mara@example.com");
      const [prefix, selector] = token.split("_");
      expect(store.consumeMagicLink(`${prefix}_${selector}_forged`)).toBeNull();
    });

    it("rejects a session token presented as a magic link", () => {
      const { token } = store.issueMagicLink("a@example.com");
      const { sessionToken } = store.consumeMagicLink(token)!;
      expect(store.consumeMagicLink(sessionToken)).toBeNull();
    });

    it("returns the same user on a second sign-in", () => {
      const first = store.consumeMagicLink(store.issueMagicLink("mara@example.com").token)!;
      const second = store.consumeMagicLink(store.issueMagicLink("mara@example.com").token)!;
      expect(second.user.id).toBe(first.user.id);
    });

    it("normalises email case", () => {
      const a = store.consumeMagicLink(store.issueMagicLink("Mara@Example.com ").token)!;
      const b = store.consumeMagicLink(store.issueMagicLink("mara@example.com").token)!;
      expect(b.user.id).toBe(a.user.id);
    });

    it("assigns non-colliding handles", () => {
      const a = store.consumeMagicLink(store.issueMagicLink("mara@a.com").token)!;
      const b = store.consumeMagicLink(store.issueMagicLink("mara@b.com").token)!;
      expect(a.user.handle).toBe("mara");
      expect(b.user.handle).toBe("mara2");
    });
  });

  describe("sessions", () => {
    const signIn = () => store.consumeMagicLink(store.issueMagicLink("m@example.com").token)!;

    it("resolves to a principal with full scopes", () => {
      const { user, sessionToken } = signIn();
      const p = store.resolve(sessionToken)!;
      expect(p).toMatchObject({ userId: user.id, via: "session" });
      expect(p.scopes).toContain("repo:write");
    });

    it("expires", () => {
      const { sessionToken } = signIn();
      advance(SESSION_TTL_MS + 1000);
      expect(store.resolve(sessionToken)).toBeNull();
    });

    it("can be revoked", () => {
      const { sessionToken } = signIn();
      expect(store.revokeSession(sessionToken)).toBe(true);
      expect(store.resolve(sessionToken)).toBeNull();
    });

    it("revokes every session for a user at once", () => {
      const { user, sessionToken } = signIn();
      const second = store.createSession(user.id);
      expect(store.revokeAllSessions(user.id)).toBe(2);
      expect(store.resolve(sessionToken)).toBeNull();
      expect(store.resolve(second)).toBeNull();
    });
  });

  describe("api tokens", () => {
    let userId: string;
    beforeEach(() => {
      userId = store.consumeMagicLink(store.issueMagicLink("m@example.com").token)!.user.id;
    });

    it("resolves with exactly the granted scopes", () => {
      const { token } = store.issueToken({ userId, name: "cli", scopes: ["repo:read"] });
      const p = store.resolve(token)!;
      expect(p.via).toBe("token");
      expect(p.scopes).toEqual(["repo:read"]);
    });

    it("can be revoked", () => {
      const { token, record } = store.issueToken({ userId, name: "cli", scopes: ["repo:read"] });
      expect(store.revokeToken(userId, record.id)).toBe(true);
      expect(store.resolve(token)).toBeNull();
    });

    it("cannot be revoked by another user", () => {
      const other = store.consumeMagicLink(store.issueMagicLink("other@example.com").token)!.user;
      const { token, record } = store.issueToken({ userId, name: "cli", scopes: ["repo:read"] });
      expect(store.revokeToken(other.id, record.id)).toBe(false);
      expect(store.resolve(token)).not.toBeNull();
    });

    it("expires", () => {
      const { token } = store.issueToken({
        userId, name: "short", scopes: ["repo:read"],
        expiresAt: new Date(clock.getTime() + 1000).toISOString(),
      });
      advance(2000);
      expect(store.resolve(token)).toBeNull();
    });

    it("records last use", () => {
      const { token, record } = store.issueToken({ userId, name: "cli", scopes: ["repo:read"] });
      store.resolve(token);
      expect(record.lastUsedAt).toBeTruthy();
    });

    it("omits revoked tokens from the listing", () => {
      const { record } = store.issueToken({ userId, name: "cli", scopes: ["repo:read"] });
      store.revokeToken(userId, record.id);
      expect(store.listTokens(userId)).toHaveLength(0);
    });
  });

  describe("resolve", () => {
    it("rejects junk without distinguishing failure modes", () => {
      for (const bad of ["", "   ", "nope", "glt_fake_secret", "gls_fake_secret", "bearer abc"]) {
        expect(store.resolve(bad), bad).toBeNull();
      }
    });
    it("rejects null and undefined", () => {
      expect(store.resolve(null)).toBeNull();
      expect(store.resolve(undefined)).toBeNull();
    });
  });
});

// -------------------------------------------------------------- permissions

describe("roleGrants", () => {
  const cases: [RepoRole, string, boolean][] = [
    ["owner", "repo:admin", true],
    ["co_author", "repo:admin", false],
    ["editor", "repo:write", true],
    ["editor", "repo:admin", false],
    ["beta_reader", "repo:read", true],
    ["beta_reader", "repo:write", false],
    ["verifier", "repo:provenance", true],
    ["verifier", "repo:read", false],
    ["verifier", "repo:write", false],
  ];
  for (const [role, cap, expected] of cases) {
    it(`${role} ${expected ? "may" : "may not"} ${cap}`, () => {
      expect(roleGrants(role, cap as never)).toBe(expected);
    });
  }

  it("lets a verifier check provenance without reading the manuscript", () => {
    expect(roleGrants("verifier", "repo:provenance")).toBe(true);
    expect(roleGrants("verifier", "repo:read")).toBe(false);
  });

  it("never lets a reviewer edit what they are attesting to", () => {
    expect(roleGrants("verifier", "repo:write")).toBe(false);
    expect(roleGrants("beta_reader", "repo:write")).toBe(false);
  });
});

describe("anonymousGrants", () => {
  it("allows reading public and unlisted books", () => {
    expect(anonymousGrants("public", "repo:read")).toBe(true);
    expect(anonymousGrants("unlisted", "repo:read")).toBe(true);
  });
  it("never allows reading a private book", () => {
    expect(anonymousGrants("private", "repo:read")).toBe(false);
  });
  it("never allows writing, however public", () => {
    expect(anonymousGrants("public", "repo:write")).toBe(false);
    expect(anonymousGrants("public", "repo:admin")).toBe(false);
  });
  it("does not expose provenance anonymously — that needs a verification link", () => {
    expect(anonymousGrants("public", "repo:provenance")).toBe(false);
  });
});

// --------------------------------------------------------------- authorize

describe("authorize", () => {
  const OWNER = "u_owner";
  const STRANGER = "u_stranger";
  const repo = (visibility: "private" | "unlisted" | "public" = "private") =>
    ({ id: "repo_1", ownerUserId: OWNER, visibility });

  const principal = (userId: string, scopes: Scope[] = ["profile", "repo:read", "repo:write", "agent:research"], via: "session" | "token" = "session"): Principal =>
    ({ userId, via, scopes });

  it("lets the owner write their own book", () => {
    const d = authorize({ principal: principal(OWNER), capability: "repo:write", repo: repo() });
    expect(d).toMatchObject({ allowed: true, reason: "owner", role: "owner" });
  });

  it("DENIES an anonymous caller on a private book", () => {
    expect(authorize({ principal: null, capability: "repo:read", repo: repo() }).allowed).toBe(false);
  });

  it("DENIES a signed-in stranger on a private book", () => {
    const d = authorize({ principal: principal(STRANGER), capability: "repo:read", repo: repo() });
    expect(d).toMatchObject({ allowed: false, reason: "not_a_collaborator" });
  });

  it("gives a signed-in stranger exactly what anonymous gets on a public book", () => {
    expect(authorize({ principal: principal(STRANGER), capability: "repo:read", repo: repo("public") }).allowed).toBe(true);
    expect(authorize({ principal: principal(STRANGER), capability: "repo:write", repo: repo("public") }).allowed).toBe(false);
  });

  it("honours collaborator roles", () => {
    const collaborators = [{ userId: STRANGER, role: "editor" as const }];
    expect(authorize({ principal: principal(STRANGER), capability: "repo:write", repo: repo(), collaborators }).allowed).toBe(true);
    expect(authorize({ principal: principal(STRANGER), capability: "repo:admin", repo: repo(), collaborators }).allowed).toBe(false);
  });

  it("stops a beta reader writing", () => {
    const collaborators = [{ userId: STRANGER, role: "beta_reader" as const }];
    const d = authorize({ principal: principal(STRANGER), capability: "repo:write", repo: repo(), collaborators });
    expect(d).toMatchObject({ allowed: false, reason: "role_insufficient", role: "beta_reader" });
  });

  it("SCOPE BOUNDS ROLE — an owner's read-only token cannot write", () => {
    const readOnly = principal(OWNER, ["repo:read"], "token");
    const d = authorize({ principal: readOnly, capability: "repo:write", repo: repo() });
    expect(d).toMatchObject({ allowed: false, reason: "scope_insufficient" });
  });

  it("checks scope before role, so a broad role cannot widen a narrow token", () => {
    const narrow = principal(OWNER, ["repo:read"], "token");
    expect(authorize({ principal: narrow, capability: "repo:admin", repo: repo() }).reason)
      .toBe("scope_insufficient");
  });

  it("an agent token may research but NOT write prose", () => {
    const agent = principal(OWNER, ["repo:read", "agent:research"], "token");
    expect(authorize({ principal: agent, capability: "agent:research", repo: repo() }).allowed).toBe(true);
    expect(authorize({ principal: agent, capability: "repo:write", repo: repo() }).allowed).toBe(false);
  });

  it("does not let an agent token on one book reach another", () => {
    const agent = principal(STRANGER, ["repo:read", "agent:research"], "token");
    expect(authorize({ principal: agent, capability: "agent:research", repo: repo() }).allowed).toBe(false);
  });

  it("keeps the author's access when their book is delisted (§16.2 rung 3)", () => {
    // Delisting changes discovery, never the author's own access.
    const d = authorize({ principal: principal(OWNER), capability: "repo:write", repo: repo("private") });
    expect(d.allowed).toBe(true);
  });

  it("fails closed for an unknown capability holder", () => {
    expect(authorize({ principal: null, capability: "repo:admin", repo: repo("public") }).allowed).toBe(false);
  });
});
