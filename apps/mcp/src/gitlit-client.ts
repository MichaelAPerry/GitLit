const API = process.env.GITLIT_API_URL ?? "http://localhost:4000";

/**
 * All traffic goes through the API, which owns authorization. The MCP server
 * used to call gitd directly, which meant an agent reached the commit path
 * without passing a single permission check.
 *
 * The token is the author's own, minted in GitLit with `agent:research` and
 * `repo:read`. It deliberately does NOT carry `repo:write`, so the credential
 * itself cannot author prose even before the path allowlist is consulted.
 */
function apiToken(): string {
  const token = process.env.GITLIT_API_TOKEN;
  if (!token) {
    throw new Error(
      "GITLIT_API_TOKEN is not set. Create a token in GitLit (Settings -> Tokens) " +
      "with the agent:research and repo:read scopes, then set it for this server.",
    );
  }
  return token;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiToken()}`,
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface RepoSummary {
  id: string; owner: string; slug: string; title: string; form: string; phase: string;
}

export const gitlit = {
  listRepositories: () =>
    call<{ repositories: RepoSummary[] }>("/v1/repositories"),

  readBlob: (owner: string, slug: string, path: string) =>
    call<{ path: string; content: string | null }>(
      `/v1/repositories/${owner}/${slug}/documents/${path}`,
    ).catch(() => ({ path, content: null })),

  tree: (owner: string, slug: string) =>
    call<{ head: string | null; files: string[] }>(`/v1/repositories/${owner}/${slug}`)
      .then((r) => ({ head: r.head, entries: r.files })),

  commitArchitecture: (owner: string, slug: string, body: unknown) =>
    call<{
      sha: string; provenance: string; spansDigest: string;
      receiptId: string; wordsAdded: number; machineShare: number;
    }>(`/v1/repositories/${owner}/${slug}/architecture`, {
      method: "POST", body: JSON.stringify(body),
    }),

  provenance: (owner: string, slug: string) =>
    call<{ spans: number; charsByOrigin: Record<string, number> }>(
      `/v1/repositories/${owner}/${slug}/provenance`,
    ),
};
