const API = process.env.GITLIT_API_URL ?? "http://localhost:4000";
const GITD = process.env.GITD_URL ?? "http://localhost:4001";

async function call<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
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
    call<{ repositories: RepoSummary[] }>(API, "/v1/repositories"),

  readBlob: (repoId: string, path: string, ref = "refs/heads/main") =>
    call<{ path: string; content: string | null }>(
      GITD, `/repos/${repoId}/blob?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
    ),

  tree: (repoId: string, ref = "refs/heads/main") =>
    call<{ head: string | null; entries: string[] }>(
      GITD, `/repos/${repoId}/tree?ref=${encodeURIComponent(ref)}`,
    ),

  commit: (repoId: string, body: unknown) =>
    call<{
      sha: string; provenance: string; spansDigest: string;
      receiptId: string; wordsAdded: number; machineShare: number;
    }>(GITD, `/repos/${repoId}/commit`, { method: "POST", body: JSON.stringify(body) }),

  provenance: (owner: string, slug: string) =>
    call<{ spans: number; charsByOrigin: Record<string, number> }>(
      API, `/v1/repositories/${owner}/${slug}/provenance`,
    ),
};
