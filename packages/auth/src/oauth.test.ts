import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { schema } from "@gitlit/db";
import { createTestDb as makeDb, truncateAll as wipe } from "@gitlit/db/testing";
import { OAuthService, OAuthError, safeReturnTo, createPkce, decodeJwtClaims } from "./oauth.js";
import { PgAuthStore } from "./pg-store.js";
import type { HttpClient } from "./oauth-providers.js";

/**
 * OAuth sign-in.
 *
 * The flow is ordinary; account linking is not. Most of what follows is about
 * one rule — an unverified provider email must never reach an existing
 * account — because that is the difference between a sign-in button and an
 * account-takeover primitive.
 */
let db: Awaited<ReturnType<typeof makeDb>>["db"];
let client: Awaited<ReturnType<typeof makeDb>>["client"];
let close: () => Promise<void>;
let auth: PgAuthStore;
let clock = new Date("2026-09-20T12:00:00Z");

/** A provider we can drive: no network, but the same code path as a real one. */
function fakeHttp(overrides: {
  token?: Record<string, unknown>;
  user?: Record<string, unknown>;
  emails?: unknown;
} = {}): HttpClient {
  return {
    async postForm() {
      return overrides.token ?? { access_token: "provider-access-token", token_type: "bearer" };
    },
    async getJson(url) {
      if (url.endsWith("/user/emails")) {
        return overrides.emails ?? [{ email: "mara@example.com", primary: true, verified: true }];
      }
      return overrides.user ?? { id: 4242, login: "mara", name: "Mara", avatar_url: "https://x/a.png" };
    },
  };
}

const CONFIGS = {
  github: { id: "github" as const, clientId: "gh-client", clientSecret: "gh-secret" },
  google: { id: "google" as const, clientId: "gg-client", clientSecret: "gg-secret" },
};

const service = (http: HttpClient = fakeHttp(), configs = CONFIGS) =>
  new OAuthService(db, configs, http, (userId) => auth.createSession(userId), () => clock);

const REDIRECT = "https://gitlit.app/v1/auth/oauth/github/callback";

async function signInWithGithub(http?: HttpClient, returnTo?: string) {
  const svc = service(http);
  const { state } = await svc.begin({ provider: "github", redirectUri: REDIRECT, returnTo });
  return svc.complete({ provider: "github", code: "auth-code", state, redirectUri: REDIRECT });
}

beforeAll(async () => { ({ db, client, close } = await makeDb()); });
beforeEach(async () => {
  clock = new Date("2026-09-20T12:00:00Z");
  await wipe(client);
  auth = new PgAuthStore(db, () => clock);
});
afterAll(async () => { await close(); });

// ------------------------------------------------------------------ helpers

describe("safeReturnTo", () => {
  it("keeps a local path", () => {
    expect(safeReturnTo("/mara/saltmarsh")).toBe("/mara/saltmarsh");
  });

  it("REFUSES AN OPEN REDIRECT", () => {
    for (const hostile of [
      "https://evil.example/steal",
      "//evil.example",
      "/\\evil.example",
      "http://evil.example",
      "/ok\r\nLocation: https://evil.example",
    ]) {
      expect(safeReturnTo(hostile), hostile).toBe("/");
    }
  });

  it("falls back to the root for nothing at all", () => {
    expect(safeReturnTo(undefined)).toBe("/");
    expect(safeReturnTo("")).toBe("/");
  });
});

describe("PKCE", () => {
  it("derives an S256 challenge that differs from the verifier", () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).not.toBe(challenge);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is unique per attempt", () => {
    const seen = new Set(Array.from({ length: 200 }, () => createPkce().verifier));
    expect(seen.size).toBe(200);
  });
});

// ------------------------------------------------------------------- begin

describe("begin", () => {
  it("builds an authorize URL with PKCE and state", async () => {
    const { url } = await service().begin({ provider: "github", redirectUri: REDIRECT });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("code_challenge")).toBeTruthy();
    expect(parsed.searchParams.get("state")).toMatch(/^glo_/);
  });

  it("requests only identity scopes — never repository access", async () => {
    const { url } = await service().begin({ provider: "github", redirectUri: REDIRECT });
    const scopes = new URL(url).searchParams.get("scope")!.split(" ");
    expect(scopes).toEqual(["read:user", "user:email"]);
    expect(scopes).not.toContain("repo");
  });

  it("sends a nonce to OIDC providers only", async () => {
    const google = await service().begin({ provider: "google", redirectUri: REDIRECT });
    expect(new URL(google.url).searchParams.get("nonce")).toBeTruthy();
    const github = await service().begin({ provider: "github", redirectUri: REDIRECT });
    expect(new URL(github.url).searchParams.get("nonce")).toBeNull();
  });

  it("never puts the client secret in the URL", async () => {
    const { url } = await service().begin({ provider: "github", redirectUri: REDIRECT });
    expect(url).not.toContain("gh-secret");
  });

  it("sanitises returnTo before storing it", async () => {
    const svc = service();
    await svc.begin({ provider: "github", redirectUri: REDIRECT, returnTo: "https://evil.example" });
    const [row] = await db.select().from(schema.oauthStates);
    expect(row!.returnTo).toBe("/");
  });

  it("rejects an unknown provider", async () => {
    await expect(service().begin({ provider: "myspace", redirectUri: REDIRECT }))
      .rejects.toThrow(/No such provider/);
  });

  it("reports an unconfigured provider as unavailable rather than failing oddly", async () => {
    const svc = service(fakeHttp(), { github: CONFIGS.github } as never);
    expect(svc.available().map((p) => p.id)).toEqual(["github"]);
    await expect(svc.begin({ provider: "google", redirectUri: REDIRECT }))
      .rejects.toThrow(/not configured/);
  });
});

// ---------------------------------------------------------------- complete

describe("state handling", () => {
  it("signs in on a valid callback", async () => {
    const result = await signInWithGithub();
    expect(result.user.email).toBe("mara@example.com");
    expect(result.sessionToken).toMatch(/^gls_/);
    expect(result.created).toBe(true);
  });

  it("IS SINGLE USE — a replayed state fails", async () => {
    const svc = service();
    const { state } = await svc.begin({ provider: "github", redirectUri: REDIRECT });
    await svc.complete({ provider: "github", code: "c", state, redirectUri: REDIRECT });
    await expect(svc.complete({ provider: "github", code: "c", state, redirectUri: REDIRECT }))
      .rejects.toThrow(/already been used/);
  });

  it("rejects a forged state with a real selector", async () => {
    const svc = service();
    const { state } = await svc.begin({ provider: "github", redirectUri: REDIRECT });
    const [prefix, selector] = state.split("_");
    await expect(svc.complete({
      provider: "github", code: "c", state: `${prefix}_${selector}_${"0".repeat(64)}`, redirectUri: REDIRECT,
    })).rejects.toThrow(/not recognised/);
  });

  it("rejects a state issued for another provider", async () => {
    const svc = service();
    const { state } = await svc.begin({ provider: "google", redirectUri: REDIRECT });
    await expect(svc.complete({ provider: "github", code: "c", state, redirectUri: REDIRECT }))
      .rejects.toThrow(/different provider/);
  });

  it("expires", async () => {
    const svc = service();
    const { state } = await svc.begin({ provider: "github", redirectUri: REDIRECT });
    clock = new Date(clock.getTime() + 11 * 60 * 1000);
    await expect(svc.complete({ provider: "github", code: "c", state, redirectUri: REDIRECT }))
      .rejects.toThrow(/expired/);
  });

  it("rejects junk", async () => {
    await expect(service().complete({ provider: "github", code: "c", state: "nope", redirectUri: REDIRECT }))
      .rejects.toThrow(/not recognised/);
  });

  it("surfaces a provider token error rather than proceeding", async () => {
    const http = fakeHttp({ token: { error: "bad_verification_code", error_description: "The code expired." } });
    await expect(signInWithGithub(http)).rejects.toThrow(/The code expired/);
  });
});

// ------------------------------------------------------------ THE rule

describe("account linking", () => {
  it("links a VERIFIED provider email to the existing account", async () => {
    const existing = (await auth.consumeMagicLink(
      (await auth.issueMagicLink("mara@example.com")).token,
    ))!.user;

    const result = await signInWithGithub();
    expect(result.user.id).toBe(existing.id);
    expect(result.linked).toBe(true);
    expect(result.created).toBe(false);
  });

  it("REFUSES AN UNVERIFIED PROVIDER EMAIL — the takeover path", async () => {
    // An attacker sets their GitHub address to the victim's and signs in.
    await auth.consumeMagicLink((await auth.issueMagicLink("mara@example.com")).token);

    const http = fakeHttp({
      user: { id: 9999, login: "attacker" },
      emails: [{ email: "mara@example.com", primary: true, verified: false }],
    });
    await expect(signInWithGithub(http)).rejects.toThrow(/has not verified/);

    // And no account was created or linked as a side effect.
    expect(await db.select().from(schema.accounts)).toHaveLength(0);
    expect(await db.select().from(schema.users)).toHaveLength(1);
  });

  it("refuses an unverified email even when no account exists to take over", async () => {
    const http = fakeHttp({ emails: [{ email: "new@example.com", primary: true, verified: false }] });
    await expect(signInWithGithub(http)).rejects.toThrow(/has not verified/);
    expect(await db.select().from(schema.users)).toHaveLength(0);
  });

  it("refuses when the provider shares no email at all", async () => {
    const http = fakeHttp({ emails: [] });
    await expect(signInWithGithub(http)).rejects.toThrow(/did not share an email/);
  });

  it("prefers the primary verified address over another verified one", async () => {
    const http = fakeHttp({ emails: [
      { email: "old@example.com", primary: false, verified: true },
      { email: "mara@example.com", primary: true, verified: true },
    ] });
    expect((await signInWithGithub(http)).user.email).toBe("mara@example.com");
  });

  it("ignores an unverified primary in favour of a verified alternative", async () => {
    const http = fakeHttp({ emails: [
      { email: "unverified@example.com", primary: true, verified: false },
      { email: "verified@example.com", primary: false, verified: true },
    ] });
    expect((await signInWithGithub(http)).user.email).toBe("verified@example.com");
  });

  it("returns the same account on a second sign-in, without relinking", async () => {
    const first = await signInWithGithub();
    const second = await signInWithGithub();
    expect(second.user.id).toBe(first.user.id);
    expect(second.linked).toBe(false);
    expect(await db.select().from(schema.accounts)).toHaveLength(1);
  });

  it("signs in by provider identity even if the address later changes", async () => {
    const first = await signInWithGithub();
    const moved = fakeHttp({ emails: [{ email: "elsewhere@example.com", primary: true, verified: true }] });
    const second = await signInWithGithub(moved);
    expect(second.user.id).toBe(first.user.id);
  });

  it("records whether the provider vouched for the address", async () => {
    await signInWithGithub();
    const [account] = await db.select().from(schema.accounts);
    expect(account!.emailVerifiedByProvider).toBe(true);
    expect(account!.linkedEmail).toBe("mara@example.com");
  });

  it("assigns a handle from the provider login, avoiding collisions", async () => {
    await auth.createUser({ email: "someone@example.com", handle: "mara" });
    expect((await signInWithGithub()).user.handle).toBe("mara2");
  });
});

describe("linking from a signed-in session", () => {
  it("attaches a provider to the current account, verified or not", async () => {
    const user = (await auth.consumeMagicLink(
      (await auth.issueMagicLink("mara@example.com")).token,
    ))!.user;

    // Unverified is acceptable HERE: they already proved control of the account.
    const http = fakeHttp({ emails: [{ email: "other@example.com", primary: true, verified: false }] });
    const svc = service(http);
    const { state } = await svc.begin({
      provider: "github", redirectUri: REDIRECT, linkUserId: user.id,
    });
    const result = await svc.complete({ provider: "github", code: "c", state, redirectUri: REDIRECT });

    expect(result.user.id).toBe(user.id);
    expect(result.linked).toBe(true);
  });

  it("refuses to steal a provider identity already linked elsewhere", async () => {
    const owner = await signInWithGithub();
    const other = (await auth.consumeMagicLink(
      (await auth.issueMagicLink("other@example.com")).token,
    ))!.user;

    const svc = service();
    const { state } = await svc.begin({
      provider: "github", redirectUri: REDIRECT, linkUserId: other.id,
    });
    await expect(svc.complete({ provider: "github", code: "c", state, redirectUri: REDIRECT }))
      .rejects.toThrow(/already linked to a different/);
    expect(owner.user.id).not.toBe(other.id);
  });
});

describe("unlinking", () => {
  it("removes a provider when an email still reaches the account", async () => {
    const user = (await auth.consumeMagicLink(
      (await auth.issueMagicLink("mara@example.com")).token,
    ))!.user;
    await signInWithGithub();
    expect(await service().unlink(user.id, "github")).toBe(true);
  });

  it("REFUSES TO REMOVE THE LAST WAY IN", async () => {
    // Created by the provider, so there is no verified email behind it.
    const result = await signInWithGithub();
    await db.update(schema.users).set({ emailVerified: null });
    await expect(service().unlink(result.user.id, "github"))
      .rejects.toThrow(/only way into this account/);
  });
});

describe("google id_token", () => {
  const jwt = (claims: Record<string, unknown>) =>
    [
      Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
      Buffer.from(JSON.stringify(claims)).toString("base64url"),
      "signature",
    ].join(".");

  const googleFlow = async (claims: Record<string, unknown>) => {
    const svc = service({
      async postForm() { return { id_token: jwt(claims) }; },
      async getJson() { return {}; },
    });
    const { state } = await svc.begin({ provider: "google", redirectUri: REDIRECT });
    const [row] = await db.select().from(schema.oauthStates);
    // Echo back the nonce the service issued, as Google would.
    const withNonce = { nonce: row!.nonce, ...claims };
    const svc2 = service({
      async postForm() { return { id_token: jwt(withNonce) }; },
      async getJson() { return {}; },
    });
    return svc2.complete({ provider: "google", code: "c", state, redirectUri: REDIRECT });
  };

  const valid = {
    iss: "https://accounts.google.com",
    sub: "google-user-1",
    aud: "gg-client",
    email: "mara@example.com",
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  it("signs in on a well-formed token", async () => {
    expect((await googleFlow(valid)).user.email).toBe("mara@example.com");
  });

  it("REJECTS A MISMATCHED NONCE — a token from another attempt", async () => {
    const svc = service({
      async postForm() { return { id_token: jwt({ ...valid, nonce: "someone-elses-nonce" }) }; },
      async getJson() { return {}; },
    });
    const { state } = await svc.begin({ provider: "google", redirectUri: REDIRECT });
    await expect(svc.complete({ provider: "google", code: "c", state, redirectUri: REDIRECT }))
      .rejects.toThrow(/does not match this sign-in attempt/);
  });

  it("rejects a foreign issuer", async () => {
    await expect(googleFlow({ ...valid, iss: "https://evil.example" }))
      .rejects.toThrow(/Unexpected id_token issuer/);
  });

  it("rejects an expired token", async () => {
    await expect(googleFlow({ ...valid, exp: Math.floor(Date.now() / 1000) - 10 }))
      .rejects.toThrow(/expired/);
  });

  it("refuses an unverified Google address", async () => {
    await expect(googleFlow({ ...valid, email_verified: false }))
      .rejects.toThrow(/has not verified/);
  });

  it("REJECTS A TOKEN MINTED FOR ANOTHER APP (aud mismatch)", async () => {
    // A valid Google token — real, verified email, good issuer and nonce — but
    // issued to someone else's client_id. Without the aud check this signs the
    // holder in as mara@example.com. OIDC §3.1.3.7 makes this a MUST.
    await expect(googleFlow({ ...valid, aud: "some-other-app.apps.googleusercontent.com" }))
      .rejects.toThrow(/not issued for this application/);
  });

  it("rejects a missing audience outright", async () => {
    const { aud, ...noAud } = valid;
    void aud;
    await expect(googleFlow(noAud)).rejects.toThrow(/not issued for this application/);
  });

  it("accepts an aud array that contains our client_id", async () => {
    expect((await googleFlow({ ...valid, aud: ["gg-client", "other"] })).user.email)
      .toBe("mara@example.com");
  });

  it("rejects when azp names a different application", async () => {
    await expect(googleFlow({ ...valid, aud: ["gg-client", "other"], azp: "other" }))
      .rejects.toThrow(/authorized for a different application/);
  });

  it("rejects a malformed token rather than trusting it", () => {
    expect(() => decodeJwtClaims("not-a-jwt")).toThrow(/not a JWT/);
    expect(() => decodeJwtClaims("a.!!!.c")).toThrow();
  });
});

describe("refusal messages point at the right remedy", () => {
  it("distinguishes 'unverified' from 'no address shared'", async () => {
    const unverified = fakeHttp({ emails: [{ email: "m@example.com", primary: true, verified: false }] });
    await expect(signInWithGithub(unverified)).rejects.toThrow(/has not verified m@example\.com/);

    const none = fakeHttp({ emails: [] });
    await expect(signInWithGithub(none)).rejects.toThrow(/did not share an email/);
  });

  it("tells the author how to proceed rather than only refusing", async () => {
    const unverified = fakeHttp({ emails: [{ email: "m@example.com", primary: true, verified: false }] });
    await expect(signInWithGithub(unverified)).rejects.toThrow(/sign in with your email instead/);
  });

  it("explains why, without implying the author did something wrong", async () => {
    const unverified = fakeHttp({ emails: [{ email: "m@example.com", primary: true, verified: false }] });
    let message = "";
    try { await signInWithGithub(unverified); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/not proof of ownership/);
    for (const word of ["suspicious", "fraud", "attack", "denied"]) {
      expect(message.toLowerCase()).not.toContain(word);
    }
  });
});
