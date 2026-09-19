export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    cache: "no-store",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface Repo {
  id: string; owner: string; slug: string; title: string; form: string;
  genre: string[]; phase: string; createdAt: string; updatedAt: string;
}

export interface Commit {
  sha: string; subject: string; message: string; author: string;
  committedAt: string; provenance: string; receipt?: string;
}
