import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV = "test";

// gitd is a separate service; these tests are about authorization, not git.
vi.mock("./gitd-client.js", () => ({
  gitd: {
    createRepo: vi.fn(async () => ({ gitdir: "/tmp/x", publicKey: "pk" })),
    readBlob: vi.fn(async (_r: string, path: string) => ({ path, content: "A sentence here." })),
    tree: vi.fn(async () => ({ head: "abc", entries: ["manuscript/chapters/01.md"] })),
    log: vi.fn(async () => []),
    commit: vi.fn(async () => ({
      sha: "a".repeat(40), provenance: "human", spansDigest: "sha256:x",
      receiptId: "rcpt_1", wordsAdded: 3, wordsRemoved: 0, machineShare: 0,
    })),
    provenance: vi.fn(async () => ({ spans: 1, charsByOrigin: { human_written: 10 } })),
  },
}));

const { resetRateLimits } = await import("./rate-limit.js");
const { app } = await import("./index.js");
const { auth } = await import("./auth-plugin.js");

beforeAll(async () => { await app.ready(); });

// Sign-in and token minting are rate limited per IP, and `inject` gives every
// request the same one. Reset between tests so the limit under test is the
// one the test is about.
beforeEach(() => { resetRateLimits(); });

/** Sign a user in the way a real client would: magic link -> session token. */
async function signIn(email: string): Promise<{ userId: string; session: string; handle: string }> {
  const { token } = await auth.issueMagicLink(email);
  const result = (await auth.consumeMagicLink(token))!;
  return { userId: result.user.id, session: result.sessionToken, handle: result.user.handle };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function createBook(session: string, slug: string, visibility = "private") {
  return app.inject({
    method: "POST", url: "/v1/repositories", headers: bearer(session),
    payload: { title: slug, slug, form: "novel", visibility },
  });
}

let mara: { userId: string; session: string; handle: string };
let stranger: { userId: string; session: string; handle: string };
let n = 0;

beforeEach(async () => {
  mara = await signIn(`mara${n}@example.com`);
  stranger = await signIn(`stranger${n}@example.com`);
  n++;
});

describe("authentication", () => {
  it("rejects an unauthenticated /v1/me", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/me" })).statusCode).toBe(401);
  });

  it("accepts a session token", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/me", headers: bearer(mara.session) });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(mara.userId);
  });

  it("rejects a forged session token", async () => {
    const forged = mara.session.slice(0, -4) + "0000";
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: bearer(forged) })).statusCode).toBe(401);
  });

  it("does not reveal whether an email has an account", async () => {
    const known = await app.inject({ method: "POST", url: "/v1/auth/magic-link", payload: { email: `mara${n - 1}@example.com` } });
    const unknown = await app.inject({ method: "POST", url: "/v1/auth/magic-link", payload: { email: "nobody@example.com" } });
    expect(known.json().message).toBe(unknown.json().message);
  });

  it("rejects a reused magic link", async () => {
    const { token } = await auth.issueMagicLink("replay@example.com");
    expect((await app.inject({ method: "POST", url: "/v1/auth/session", payload: { token } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/auth/session", payload: { token } })).statusCode).toBe(401);
  });

  it("sets an HttpOnly session cookie", async () => {
    const { token } = await auth.issueMagicLink("cookie@example.com");
    const res = await app.inject({ method: "POST", url: "/v1/auth/session", payload: { token } });
    expect(res.headers["set-cookie"]).toMatch(/HttpOnly/);
    expect(res.headers["set-cookie"]).toMatch(/SameSite=Lax/);
  });
});

describe("repository creation", () => {
  it("requires a signed-in user", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/repositories",
      payload: { title: "X", slug: "x", form: "novel" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("owns the book to the creator, not a hardcoded demo user", async () => {
    const res = await createBook(mara.session, "saltmarsh");
    expect(res.statusCode).toBe(201);
    expect(res.json().ownerUserId).toBe(mara.userId);
  });
});

describe("private book access", () => {
  let slug: string;
  beforeEach(async () => {
    slug = `book${n}`;
    await createBook(mara.session, slug);
  });
  const url = (owner: string, s: string, suffix = "") =>
    `/v1/repositories/${owner}/${s}${suffix}`;
  const handle = () => mara.handle;

  it("the owner can read it", async () => {
    const res = await app.inject({ method: "GET", url: url(handle(), slug), headers: bearer(mara.session) });
    expect(res.statusCode).toBe(200);
  });

  it("ANONYMOUS gets 404, not 403 — existence is itself sensitive", async () => {
    const res = await app.inject({ method: "GET", url: url(handle(), slug) });
    expect(res.statusCode).toBe(404);
  });

  it("a signed-in stranger also gets 404", async () => {
    const res = await app.inject({ method: "GET", url: url(handle(), slug), headers: bearer(stranger.session) });
    expect(res.statusCode).toBe(404);
  });

  it("a stranger CANNOT write to it", async () => {
    const res = await app.inject({
      method: "PUT", url: url(handle(), slug, "/documents/manuscript/chapters/01.md"),
      headers: bearer(stranger.session), payload: { content: "Mine now." },
    });
    expect(res.statusCode).toBe(404);
  });

  it("a stranger cannot read its provenance", async () => {
    const res = await app.inject({ method: "GET", url: url(handle(), slug, "/provenance"), headers: bearer(stranger.session) });
    expect(res.statusCode).toBe(404);
  });

  it("does not list it for a stranger", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/repositories", headers: bearer(stranger.session) });
    expect(res.json().repositories.map((r: { slug: string }) => r.slug)).not.toContain(slug);
  });

  it("does not list it anonymously", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/repositories" });
    expect(res.json().repositories).toHaveLength(0);
  });
});

describe("collaborator roles", () => {
  let slug: string;
  const handle = () => mara.handle;
  const strangerHandle = () => stranger.handle;

  beforeEach(async () => {
    slug = `collab${n}`;
    await createBook(mara.session, slug);
  });

  const addAs = (role: string) =>
    app.inject({
      method: "POST", url: `/v1/repositories/${handle()}/${slug}/collaborators`,
      headers: bearer(mara.session), payload: { handle: strangerHandle(), role },
    });

  it("an editor can read and write", async () => {
    expect((await addAs("editor")).statusCode).toBe(200);
    const read = await app.inject({
      method: "GET", url: `/v1/repositories/${handle()}/${slug}`, headers: bearer(stranger.session),
    });
    expect(read.statusCode).toBe(200);
    const write = await app.inject({
      method: "PUT", url: `/v1/repositories/${handle()}/${slug}/documents/manuscript/chapters/01.md`,
      headers: bearer(stranger.session), payload: { content: "Edited." },
    });
    expect(write.statusCode).toBe(200);
  });

  it("a BETA READER can read but NOT write", async () => {
    await addAs("beta_reader");
    const read = await app.inject({
      method: "GET", url: `/v1/repositories/${handle()}/${slug}`, headers: bearer(stranger.session),
    });
    expect(read.statusCode).toBe(200);
    const write = await app.inject({
      method: "PUT", url: `/v1/repositories/${handle()}/${slug}/documents/manuscript/chapters/01.md`,
      headers: bearer(stranger.session), payload: { content: "Not allowed." },
    });
    expect(write.statusCode).toBe(403);
  });

  it("a collaborator cannot manage collaborators", async () => {
    await addAs("editor");
    const res = await app.inject({
      method: "POST", url: `/v1/repositories/${handle()}/${slug}/collaborators`,
      headers: bearer(stranger.session), payload: { handle: "someone", role: "editor" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a stranger cannot add themselves", async () => {
    const res = await app.inject({
      method: "POST", url: `/v1/repositories/${handle()}/${slug}/collaborators`,
      headers: bearer(stranger.session), payload: { handle: strangerHandle(), role: "editor" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("removing a collaborator revokes their access", async () => {
    await addAs("editor");
    await app.inject({
      method: "DELETE", url: `/v1/repositories/${handle()}/${slug}/collaborators/${strangerHandle()}`,
      headers: bearer(mara.session),
    });
    const res = await app.inject({
      method: "GET", url: `/v1/repositories/${handle()}/${slug}`, headers: bearer(stranger.session),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("public books", () => {
  it("are readable anonymously but not writable", async () => {
    const slug = `open${n}`;
    await createBook(mara.session, slug, "public");
    const handle = mara.handle;

    expect((await app.inject({ method: "GET", url: `/v1/repositories/${handle}/${slug}` })).statusCode).toBe(200);
    const write = await app.inject({
      method: "PUT", url: `/v1/repositories/${handle}/${slug}/documents/manuscript/chapters/01.md`,
      payload: { content: "Vandalism." },
    });
    expect(write.statusCode).toBe(401);
  });

  // Public means the prose is readable, not that the provenance record is.
  // Anonymous provenance access goes through a verification link, which has
  // its own token so views can be counted and revoked (§12.6).
  it("do not expose provenance anonymously", async () => {
    const slug = `open2${n}`;
    await createBook(mara.session, slug, "public");
    const handle = mara.handle;
    const res = await app.inject({ method: "GET", url: `/v1/repositories/${handle}/${slug}/provenance` });
    expect(res.statusCode).not.toBe(200);
    // 401, not 403: signing in as someone with access would succeed.
    expect(res.statusCode).toBe(401);
  });
});

describe("api tokens", () => {
  it("a read-only token CANNOT write", async () => {
    const slug = `tok${n}`;
    await createBook(mara.session, slug);
    const handle = mara.handle;

    const made = await app.inject({
      method: "POST", url: "/v1/tokens", headers: bearer(mara.session),
      payload: { name: "reader", scopes: ["repo:read"] },
    });
    const token = made.json().token as string;

    expect((await app.inject({
      method: "GET", url: `/v1/repositories/${handle}/${slug}`, headers: bearer(token),
    })).statusCode).toBe(200);

    const write = await app.inject({
      method: "PUT", url: `/v1/repositories/${handle}/${slug}/documents/manuscript/chapters/01.md`,
      headers: bearer(token), payload: { content: "Nope." },
    });
    expect(write.statusCode).toBe(403);
  });

  it("never returns the token again after creation", async () => {
    await app.inject({
      method: "POST", url: "/v1/tokens", headers: bearer(mara.session),
      payload: { name: "cli", scopes: ["repo:read"] },
    });
    const listed = await app.inject({ method: "GET", url: "/v1/tokens", headers: bearer(mara.session) });
    const body = JSON.stringify(listed.json());
    expect(body).not.toMatch(/glt_/);
    expect(body).not.toMatch(/verifier/);
  });

  it("cannot be used to mint another token", async () => {
    const made = await app.inject({
      method: "POST", url: "/v1/tokens", headers: bearer(mara.session),
      payload: { name: "cli", scopes: ["repo:write"] },
    });
    const res = await app.inject({
      method: "POST", url: "/v1/tokens", headers: bearer(made.json().token),
      payload: { name: "escalated", scopes: ["repo:write", "agent:research"] },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a revoked token stops working immediately", async () => {
    const made = await app.inject({
      method: "POST", url: "/v1/tokens", headers: bearer(mara.session),
      payload: { name: "cli", scopes: ["repo:read"] },
    });
    const { token, record } = made.json();
    await app.inject({ method: "DELETE", url: `/v1/tokens/${record.id}`, headers: bearer(mara.session) });
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: bearer(token) })).statusCode).toBe(401);
  });

  it("cannot revoke another user's token", async () => {
    const made = await app.inject({
      method: "POST", url: "/v1/tokens", headers: bearer(mara.session),
      payload: { name: "cli", scopes: ["repo:read"] },
    });
    const res = await app.inject({
      method: "DELETE", url: `/v1/tokens/${made.json().record.id}`, headers: bearer(stranger.session),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("authoring sessions", () => {
  it("cannot be written into by another user", async () => {
    const slug = `sess${n}`;
    await createBook(mara.session, slug);
    const handle = mara.handle;

    const opened = await app.inject({
      method: "POST", url: `/v1/repositories/${handle}/${slug}/sessions`,
      headers: bearer(mara.session), payload: { path: "manuscript/chapters/01.md" },
    });
    const { sessionId } = opened.json();

    const res = await app.inject({
      method: "PATCH", url: `/v1/sessions/${sessionId}`,
      headers: bearer(stranger.session), payload: { keystrokes: 9999 },
    });
    expect(res.statusCode).toBe(404);
  });
});
