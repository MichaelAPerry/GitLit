/**
 * Phase 0/1 placeholder for the repositories index.
 *
 * Postgres is only an index over Git (§2.3), so swapping this for @gitlit/db
 * does not change the commit path or any provenance behaviour. Kept in memory
 * for now so the dashboard runs with no database.
 */
export interface RepoRecord {
  id: string;
  owner: string;
  slug: string;
  title: string;
  form: string;
  genre: string[];
  targetWords?: number;
  phase: string;
  createdAt: string;
  updatedAt: string;
}

const rows = new Map<string, RepoRecord>();

export const repos = {
  create(input: Omit<RepoRecord, "phase" | "createdAt" | "updatedAt">): RepoRecord {
    const now = new Date().toISOString();
    const record: RepoRecord = { ...input, phase: "premise", createdAt: now, updatedAt: now };
    rows.set(record.id, record);
    return record;
  },
  find: (owner: string, slug: string) =>
    [...rows.values()].find((r) => r.owner === owner && r.slug === slug),
  list: () => [...rows.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  touch(id: string) {
    const r = rows.get(id);
    if (r) r.updatedAt = new Date().toISOString();
  },
};
