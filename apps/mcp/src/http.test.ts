import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The HTTP transport's authentication.
 *
 * This used to accept any bearer token and map every caller to one user —
 * and, worse, made every downstream call with a single server-side token, so
 * an authenticated author acted with the operator's permissions. Both halves
 * are covered here.
 */
const ME = "http://localhost:4000/v1/me";

function mockApi(responses: Record<string, { status: number; body?: unknown }>) {
  const calls: { url: string; token?: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const token = (init?.headers as Record<string, string> | undefined)?.authorization
      ?.replace("Bearer ", "");
    calls.push({ url: String(url), token });
    const match = responses[token ?? ""] ?? { status: 401 };
    return {
      ok: match.status < 400,
      status: match.status,
      json: async () => match.body ?? {},
      text: async () => JSON.stringify(match.body ?? {}),
    } as Response;
  }));
  return calls;
}

const identityOf = (id: string, handle: string, scopes: string[]) =>
  ({ status: 200, body: { user: { id, handle }, scopes } });

let identify: typeof import("./gitlit-client.js").identify;
let createGitlitClient: typeof import("./gitlit-client.js").createGitlitClient;

beforeEach(async () => {
  vi.resetModules();
  ({ identify, createGitlitClient } = await import("./gitlit-client.js"));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("identify", () => {
  it("resolves a good token to its owner and scopes", async () => {
    mockApi({ glt_good: identityOf("u_1", "mara", ["repo:read", "agent:research"]) });
    const identity = await identify("glt_good");
    expect(identity).toEqual({ userId: "u_1", handle: "mara", scopes: ["repo:read", "agent:research"] });
  });

  it("REJECTS AN UNKNOWN TOKEN instead of defaulting to a user", async () => {
    mockApi({ glt_good: identityOf("u_1", "mara", ["agent:research"]) });
    expect(await identify("glt_forged")).toBeNull();
    expect(await identify("")).toBeNull();
  });

  it("returns null rather than throwing when the API is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await identify("glt_any")).toBeNull();
  });

  it("distinguishes two tokens as two different users", async () => {
    mockApi({
      glt_a: identityOf("u_a", "mara", ["agent:research"]),
      glt_b: identityOf("u_b", "eve", ["agent:research"]),
    });
    expect((await identify("glt_a"))?.userId).toBe("u_a");
    expect((await identify("glt_b"))?.userId).toBe("u_b");
  });
});

describe("the client acts as the caller, never as the server", () => {
  it("SENDS THE CALLER'S OWN TOKEN DOWNSTREAM", async () => {
    const calls = mockApi({
      glt_mara: { status: 200, body: { repositories: [] } },
      glt_eve: { status: 200, body: { repositories: [] } },
    });

    await createGitlitClient("glt_mara").listRepositories();
    await createGitlitClient("glt_eve").listRepositories();

    expect(calls.map((c) => c.token)).toEqual(["glt_mara", "glt_eve"]);
  });

  it("does not read a token from the environment", async () => {
    process.env.GITLIT_API_TOKEN = "glt_operator_secret";
    try {
      const calls = mockApi({ glt_caller: { status: 200, body: { repositories: [] } } });
      await createGitlitClient("glt_caller").listRepositories();
      expect(calls.every((c) => c.token === "glt_caller")).toBe(true);
      expect(calls.some((c) => c.token === "glt_operator_secret")).toBe(false);
    } finally {
      delete process.env.GITLIT_API_TOKEN;
    }
  });

  it("carries the caller's token on every method, not just the first", async () => {
    const calls = mockApi({ glt_mara: { status: 200, body: { spans: 0, charsByOrigin: {} } } });
    const client = createGitlitClient("glt_mara");
    await client.provenance("mara", "saltmarsh");
    await client.readBlob("mara", "saltmarsh", "manuscript/chapters/01.md");
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((c) => c.token === "glt_mara")).toBe(true);
  });

  it("surfaces an API refusal rather than returning empty data", async () => {
    mockApi({ glt_mara: { status: 403, body: { detail: "forbidden" } } });
    await expect(createGitlitClient("glt_mara").listRepositories()).rejects.toThrow(/403/);
  });

  it("reports a missing document as absent, which is not an error", async () => {
    mockApi({ glt_mara: { status: 404 } });
    const result = await createGitlitClient("glt_mara").readBlob("mara", "s", "missing.md");
    expect(result.content).toBeNull();
  });
});

describe("scope", () => {
  it("a token without agent:research is identifiable but not entitled", async () => {
    mockApi({ glt_readonly: identityOf("u_1", "mara", ["repo:read"]) });
    const identity = await identify("glt_readonly");
    expect(identity).not.toBeNull();
    // The transport refuses it; identification alone does not entitle.
    expect(identity!.scopes).not.toContain("agent:research");
  });
});
