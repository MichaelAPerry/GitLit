const API = process.env.GITLIT_API_URL ?? "http://localhost:4000";

/**
 * All traffic goes through the API, which owns authorization. The MCP server
 * used to call gitd directly, which meant an agent reached the commit path
 * without passing a single permission check.
 *
 * THE SERVER HAS NO IDENTITY OF ITS OWN. Every downstream call carries the
 * caller's token, never a shared one held in the environment. A single
 * server-side credential would make this a confused deputy: authenticate one
 * author at the door, then act on their behalf with whatever permissions the
 * operator's token happens to hold. Over stdio the caller is the author
 * running the process; over HTTP it is whoever presented the bearer.
 *
 * The token is minted in GitLit with `agent:research` and `repo:read`. It
 * deliberately does NOT carry `repo:write`, so the credential itself cannot
 * author prose even before the path allowlist is consulted.
 */
export interface GitlitClient {
  listRepositories(): Promise<{ repositories: RepoSummary[] }>;
  readBlob(owner: string, slug: string, path: string): Promise<{ path: string; content: string | null }>;
  tree(owner: string, slug: string): Promise<{ head: string | null; entries: string[] }>;
  commitArchitecture(owner: string, slug: string, body: unknown): Promise<CommitResult>;
  provenance(owner: string, slug: string): Promise<{ spans: number; charsByOrigin: Record<string, number> }>;
}

export interface CommitResult {
  sha: string; provenance: string; spansDigest: string;
  receiptId: string; wordsAdded: number; machineShare: number;
}

export interface TokenIdentity { userId: string; handle: string; scopes: string[] }

/** Resolve a token to its owner, or null. Used to authenticate a connection. */
export async function identify(token: string): Promise<TokenIdentity | null> {
  try {
    const res = await fetch(`${API}/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      user: { id: string; handle: string }; scopes: string[];
    };
    return { userId: body.user.id, handle: body.user.handle, scopes: body.scopes ?? [] };
  } catch {
    return null;
  }
}

export function createGitlitClient(token: string): GitlitClient {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  return {
    listRepositories: () => call("/v1/repositories"),

    readBlob: (owner, slug, path) =>
      call<{ path: string; content: string | null }>(
        `/v1/repositories/${owner}/${slug}/documents/${path}`,
      ).catch(() => ({ path, content: null })),

    tree: (owner, slug) =>
      call<{ head: string | null; files: string[] }>(`/v1/repositories/${owner}/${slug}`)
        .then((r) => ({ head: r.head, entries: r.files })),

    commitArchitecture: (owner, slug, body) =>
      call<CommitResult>(`/v1/repositories/${owner}/${slug}/architecture`, {
        method: "POST", body: JSON.stringify(body),
      }),

    provenance: (owner, slug) =>
      call(`/v1/repositories/${owner}/${slug}/provenance`),
  };
}

export interface RepoSummary {
  id: string; owner: string; slug: string; title: string; form: string; phase: string;
}

