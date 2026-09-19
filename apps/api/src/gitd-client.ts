const GITD = process.env.GITD_URL ?? "http://localhost:4001";
const SERVICE_TOKEN = process.env.GITD_SERVICE_TOKEN;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GITD}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(SERVICE_TOKEN ? { authorization: `Bearer ${SERVICE_TOKEN}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`gitd ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const gitd = {
  createRepo: (repoId: string, defaultBranch = "main") =>
    call<{ gitdir: string; publicKey: string }>("/repos", {
      method: "POST", body: JSON.stringify({ repoId, defaultBranch }),
    }),

  readBlob: (repoId: string, path: string, ref = "refs/heads/main") =>
    call<{ path: string; content: string | null }>(
      `/repos/${repoId}/blob?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
    ),

  tree: (repoId: string, ref = "refs/heads/main") =>
    call<{ head: string | null; entries: string[] }>(
      `/repos/${repoId}/tree?ref=${encodeURIComponent(ref)}`,
    ),

  log: (repoId: string, ref = "refs/heads/main", depth = 50) =>
    call<{ sha: string; message: string; author: string; committedAt: string; parents: string[] }[]>(
      `/repos/${repoId}/log?ref=${encodeURIComponent(ref)}&depth=${depth}`,
    ),

  commit: (repoId: string, body: unknown) =>
    call<{
      sha: string; provenance: "ai" | "hybrid" | "human"; spansDigest: string;
      receiptId: string; wordsAdded: number; wordsRemoved: number; machineShare: number;
    }>(`/repos/${repoId}/commit`, { method: "POST", body: JSON.stringify(body) }),
};
