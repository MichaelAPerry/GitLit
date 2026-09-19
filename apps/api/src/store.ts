/**
 * Phase 0/1 placeholder for the repositories index.
 *
 * Postgres is only an index over Git (§2.3), so swapping this for @gitlit/db
 * does not change the commit path or any provenance behaviour. Kept in memory
 * for now so the dashboard runs with no database.
 */
export interface RepoRecord {
  id: string;
  /** Handle of the owning user, used in URLs. */
  owner: string;
  ownerUserId: string;
  slug: string;
  title: string;
  form: string;
  genre: string[];
  targetWords?: number;
  phase: string;
  visibility: "private" | "unlisted" | "public";
  collaborators: { userId: string; role: "owner" | "co_author" | "editor" | "beta_reader" | "verifier" }[];
  createdAt: string;
  updatedAt: string;
}

const rows = new Map<string, RepoRecord>();

export const repos = {
  create(input: Omit<RepoRecord, "phase" | "createdAt" | "updatedAt" | "collaborators">): RepoRecord {
    const now = new Date().toISOString();
    const record: RepoRecord = {
      ...input, phase: "premise", collaborators: [], createdAt: now, updatedAt: now,
    };
    rows.set(record.id, record);
    return record;
  },
  find: (owner: string, slug: string) =>
    [...rows.values()].find((r) => r.owner === owner && r.slug === slug),
  /** Repos a user can see: their own, plus ones they collaborate on. */
  listFor: (userId: string | null) =>
    [...rows.values()]
      .filter((r) =>
        (userId !== null &&
          (r.ownerUserId === userId || r.collaborators.some((c) => c.userId === userId))) ||
        r.visibility === "public")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),

  addCollaborator(repoId: string, userId: string, role: RepoRecord["collaborators"][number]["role"]) {
    const repo = rows.get(repoId);
    if (!repo) return undefined;
    repo.collaborators = repo.collaborators.filter((c) => c.userId !== userId);
    repo.collaborators.push({ userId, role });
    return repo;
  },

  removeCollaborator(repoId: string, userId: string) {
    const repo = rows.get(repoId);
    if (!repo) return undefined;
    repo.collaborators = repo.collaborators.filter((c) => c.userId !== userId);
    return repo;
  },
  touch(id: string) {
    const r = rows.get(id);
    if (r) r.updatedAt = new Date().toISOString();
  },
};
