import { and, desc, eq } from "drizzle-orm";
import { schema } from "@gitlit/db";
import { newAuthoringSessionId } from "@gitlit/core";
import { db } from "./db.js";

/**
 * Authoring sessions and input events (§7.5.5), in Postgres.
 *
 * Input events store a content hash and never the text (§7.5.1). They also
 * carry an expiry: the record exists to establish how a manuscript was written,
 * not to accumulate a permanent log of everything an author ever pasted.
 */

const EVENT_RETENTION_MONTHS = 24;

export interface InputEventRecord {
  inputMode: "pasted" | "dictated" | "composed" | "dropped" | "imported" | "ai_tool" | "synthetic";
  charCount: number;
  wordCount: number;
  contentHash: string;
  isTrusted: boolean;
  occurredAt: string;
  authorNote?: string;
  authorNotedAt?: string;
}

export interface AuthoringSession {
  id: string;
  repoId: string;
  userId: string;
  path: string;
  client: string;
  startedAt: string;
  endedAt?: string;
  keystrokes: number;
  medianWpm: number | null;
  modeWords: Record<string, number>;
  events: InputEventRecord[];
  commitShas: string[];
}

type SessionRow = typeof schema.authoringSessions.$inferSelect;
type EventRow = typeof schema.inputEvents.$inferSelect;

const toEvent = (r: EventRow): InputEventRecord => ({
  inputMode: r.inputMode as InputEventRecord["inputMode"],
  charCount: r.charCount,
  wordCount: r.wordCount,
  contentHash: r.contentHash,
  isTrusted: r.isTrusted,
  occurredAt: r.occurredAt.toISOString(),
  authorNote: r.authorNote ?? undefined,
  authorNotedAt: r.authorNotedAt?.toISOString(),
});

const toSession = (r: SessionRow, events: EventRow[]): AuthoringSession => ({
  id: r.id,
  repoId: r.repoId,
  userId: r.userId,
  path: r.paths[0] ?? "",
  client: r.client,
  startedAt: r.startedAt.toISOString(),
  endedAt: r.endedAt?.toISOString(),
  keystrokes: r.keystrokes,
  medianWpm: r.medianWpm ?? null,
  modeWords: (r.modeWords ?? {}) as Record<string, number>,
  events: events.map(toEvent),
  commitShas: r.commitShas,
});

async function load(id: string): Promise<AuthoringSession | undefined> {
  const [row] = await db().select().from(schema.authoringSessions)
    .where(eq(schema.authoringSessions.id, id));
  if (!row) return undefined;
  const events = await db().select().from(schema.inputEvents)
    .where(eq(schema.inputEvents.sessionId, id))
    .orderBy(schema.inputEvents.occurredAt);
  return toSession(row, events);
}

export const authoringSessions = {
  async open(input: { repoId: string; userId: string; path: string; client: string }): Promise<AuthoringSession> {
    const [row] = await db().insert(schema.authoringSessions).values({
      id: newAuthoringSessionId(),
      repoId: input.repoId,
      userId: input.userId,
      startedAt: new Date(),
      paths: [input.path],
      client: input.client,
    }).returning();
    return toSession(row!, []);
  },

  get: load,

  async update(id: string, patch: {
    keystrokes?: number; medianWpm?: number | null;
    modeWords?: Record<string, number>; events?: InputEventRecord[];
  }): Promise<AuthoringSession | undefined> {
    const existing = await load(id);
    if (!existing) return undefined;

    const set: Partial<typeof schema.authoringSessions.$inferInsert> = {};
    if (patch.keystrokes !== undefined) set.keystrokes = patch.keystrokes;
    if (patch.medianWpm !== undefined) set.medianWpm = patch.medianWpm ?? undefined;
    if (patch.modeWords) set.modeWords = patch.modeWords;
    if (Object.keys(set).length > 0) {
      await db().update(schema.authoringSessions).set(set)
        .where(eq(schema.authoringSessions.id, id));
    }

    if (patch.events?.length) {
      // An event is identified by (hash, timestamp); a client retrying a sync
      // must not double-record what it already sent.
      const seen = new Set(existing.events.map((e) => `${e.contentHash}:${e.occurredAt}`));
      const fresh = patch.events.filter((e) => !seen.has(`${e.contentHash}:${new Date(e.occurredAt).toISOString()}`));
      if (fresh.length > 0) {
        const expires = new Date();
        expires.setMonth(expires.getMonth() + EVENT_RETENTION_MONTHS);
        await db().insert(schema.inputEvents).values(fresh.map((e) => ({
          sessionId: id,
          repoId: existing.repoId,
          path: existing.path,
          occurredAt: new Date(e.occurredAt),
          inputMode: e.inputMode,
          charCount: e.charCount,
          wordCount: e.wordCount,
          contentHash: e.contentHash,
          isTrusted: e.isTrusted,
          expiresAt: expires,
        })));
      }
    }
    return load(id);
  },

  async close(id: string, commitSha?: string): Promise<AuthoringSession | undefined> {
    const existing = await load(id);
    if (!existing) return undefined;
    await db().update(schema.authoringSessions).set({
      endedAt: new Date(),
      commitShas: commitSha ? [...existing.commitShas, commitSha] : existing.commitShas,
    }).where(eq(schema.authoringSessions.id, id));
    return load(id);
  },

  async attachCommit(id: string, sha: string): Promise<void> {
    const existing = await load(id);
    if (!existing) return;
    await db().update(schema.authoringSessions)
      .set({ commitShas: [...existing.commitShas, sha] })
      .where(eq(schema.authoringSessions.id, id));
  },

  /** The author's account of a paste. Stored as a claim, never as observation. */
  async annotate(sessionId: string, contentHash: string, note: string): Promise<InputEventRecord | undefined> {
    const [row] = await db().update(schema.inputEvents)
      .set({ authorNote: note, authorNotedAt: new Date() })
      .where(and(
        eq(schema.inputEvents.sessionId, sessionId),
        eq(schema.inputEvents.contentHash, contentHash),
      ))
      .returning();
    return row ? toEvent(row) : undefined;
  },

  async forRepo(repoId: string): Promise<AuthoringSession[]> {
    const rows = await db().select().from(schema.authoringSessions)
      .where(eq(schema.authoringSessions.repoId, repoId))
      .orderBy(desc(schema.authoringSessions.startedAt), desc(schema.authoringSessions.id));
    return Promise.all(rows.map(async (r) => (await load(r.id))!));
  },
};

/** Evidence strings for the commit trailer, derived from what we recorded. */
export function evidenceFor(session: AuthoringSession): string[] {
  const evidence = [`client:${session.client}`, `keystrokes:${session.keystrokes}`];
  const byMode = new Map<string, number>();
  for (const e of session.events) byMode.set(e.inputMode, (byMode.get(e.inputMode) ?? 0) + e.wordCount);
  for (const [mode, words] of byMode) evidence.push(`${mode}:${words}`);
  if (session.events.some((e) => !e.isTrusted)) evidence.push("synthetic_input_observed");
  return evidence;
}
