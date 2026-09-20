import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { schema } from "@gitlit/db";
import type { RepoRole, Visibility } from "@gitlit/auth";
import { db } from "./db.js";

export interface RepoRecord {
  id: string;
  owner: string;
  ownerUserId: string;
  slug: string;
  title: string;
  form: string;
  genre: string[];
  targetWords?: number;
  phase: string;
  visibility: Visibility;
  storagePath: string;
  collaborators: { userId: string; role: RepoRole }[];
  createdAt: string;
  updatedAt: string;
}

type Row = typeof schema.repositories.$inferSelect;

function toRecord(row: Row, ownerHandle: string, collaborators: { userId: string; role: RepoRole }[]): RepoRecord {
  return {
    id: row.id,
    owner: ownerHandle,
    ownerUserId: row.ownerUserId!,
    slug: row.slug,
    title: row.title,
    form: row.form,
    genre: row.genre ?? [],
    targetWords: row.targetWords ?? undefined,
    phase: row.phase,
    visibility: row.visibility as Visibility,
    storagePath: row.storagePath,
    collaborators,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function collaboratorsFor(repoIds: string[]) {
  if (repoIds.length === 0) return new Map<string, { userId: string; role: RepoRole }[]>();
  const rows = await db().select().from(schema.repositoryCollaborators)
    .where(inArray(schema.repositoryCollaborators.repoId, repoIds));
  const map = new Map<string, { userId: string; role: RepoRole }[]>();
  for (const r of rows) {
    map.set(r.repoId, [...(map.get(r.repoId) ?? []), { userId: r.userId, role: r.role as RepoRole }]);
  }
  return map;
}

export const repos = {
  async create(input: {
    id: string; ownerUserId: string; ownerHandle: string; slug: string; title: string;
    form: string; genre?: string[]; targetWords?: number; visibility?: Visibility;
    storagePath: string;
  }): Promise<RepoRecord> {
    const [row] = await db().insert(schema.repositories).values({
      id: input.id,
      ownerUserId: input.ownerUserId,
      slug: input.slug,
      title: input.title,
      form: input.form,
      genre: input.genre ?? [],
      targetWords: input.targetWords,
      visibility: input.visibility ?? "private",
      storagePath: input.storagePath,
    }).returning();
    return toRecord(row!, input.ownerHandle, []);
  },

  async find(ownerHandle: string, slug: string): Promise<RepoRecord | undefined> {
    const [row] = await db().select({ repo: schema.repositories, handle: schema.users.handle })
      .from(schema.repositories)
      .innerJoin(schema.users, eq(schema.repositories.ownerUserId, schema.users.id))
      .where(and(eq(schema.users.handle, ownerHandle.toLowerCase()), eq(schema.repositories.slug, slug)));
    if (!row) return undefined;
    const collabs = await collaboratorsFor([row.repo.id]);
    return toRecord(row.repo, row.handle, collabs.get(row.repo.id) ?? []);
  },

  /**
   * Books a caller may see: their own, ones they collaborate on, and public
   * ones. Filtering happens in SQL rather than after the fetch — pulling every
   * repository into the process and discarding most of them is how a listing
   * endpoint becomes an accidental disclosure the day someone forgets a filter.
   */
  async listFor(userId: string | null): Promise<RepoRecord[]> {
    const visible = userId
      ? or(
          eq(schema.repositories.ownerUserId, userId),
          eq(schema.repositories.visibility, "public"),
          sql`exists (select 1 from ${schema.repositoryCollaborators} rc
                      where rc.repo_id = ${schema.repositories.id} and rc.user_id = ${userId})`,
        )
      : eq(schema.repositories.visibility, "public");

    const rows = await db().select({ repo: schema.repositories, handle: schema.users.handle })
      .from(schema.repositories)
      .innerJoin(schema.users, eq(schema.repositories.ownerUserId, schema.users.id))
      .where(visible)
      .orderBy(desc(schema.repositories.updatedAt));

    const collabs = await collaboratorsFor(rows.map((r) => r.repo.id));
    return rows.map((r) => toRecord(r.repo, r.handle, collabs.get(r.repo.id) ?? []));
  },

  async touch(id: string): Promise<void> {
    await db().update(schema.repositories).set({ updatedAt: new Date() })
      .where(eq(schema.repositories.id, id));
  },

  async addCollaborator(repoId: string, userId: string, role: RepoRole): Promise<void> {
    await db().delete(schema.repositoryCollaborators).where(and(
      eq(schema.repositoryCollaborators.repoId, repoId),
      eq(schema.repositoryCollaborators.userId, userId),
    ));
    await db().insert(schema.repositoryCollaborators).values({ repoId, userId, role });
  },

  async removeCollaborator(repoId: string, userId: string): Promise<void> {
    await db().delete(schema.repositoryCollaborators).where(and(
      eq(schema.repositoryCollaborators.repoId, repoId),
      eq(schema.repositoryCollaborators.userId, userId),
    ));
  },
};
