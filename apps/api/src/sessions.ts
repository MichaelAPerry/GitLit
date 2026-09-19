import { newAuthoringSessionId } from "@gitlit/core";

/**
 * Authoring session store (§7.5.5).
 *
 * This replaces endpoints that validated a request body and returned
 * `{recorded: N}` for data they discarded. A stub should fail loudly; something
 * that reports success for dropped data is worse than a missing feature,
 * because it reads as working to everyone who comes after.
 *
 * In-memory like `store.ts`, and honest about it — the `authoring_sessions` and
 * `input_events` tables in @gitlit/db are the destination. What matters is that
 * what the endpoint claims to record, it records.
 */

export interface InputEventRecord {
  inputMode: "pasted" | "dictated" | "composed" | "dropped" | "imported" | "ai_tool" | "synthetic";
  charCount: number;
  wordCount: number;
  /** Hash only. The inserted text is never sent and never stored (§7.5.1). */
  contentHash: string;
  isTrusted: boolean;
  occurredAt: string;
  /** An AUTHOR CLAIM about where it came from, distinct from our observation. */
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

const rows = new Map<string, AuthoringSession>();

export const authoringSessions = {
  open(input: { repoId: string; userId: string; path: string; client: string }): AuthoringSession {
    const session: AuthoringSession = {
      id: newAuthoringSessionId(),
      ...input,
      startedAt: new Date().toISOString(),
      keystrokes: 0,
      medianWpm: null,
      modeWords: {},
      events: [],
      commitShas: [],
    };
    rows.set(session.id, session);
    return session;
  },

  get: (id: string) => rows.get(id),

  /** Aggregates are replaced (the client sends running totals); events append. */
  update(
    id: string,
    patch: {
      keystrokes?: number;
      medianWpm?: number | null;
      modeWords?: Record<string, number>;
      events?: InputEventRecord[];
    },
  ): AuthoringSession | undefined {
    const session = rows.get(id);
    if (!session) return undefined;
    if (patch.keystrokes !== undefined) session.keystrokes = patch.keystrokes;
    if (patch.medianWpm !== undefined) session.medianWpm = patch.medianWpm;
    if (patch.modeWords) session.modeWords = patch.modeWords;
    if (patch.events?.length) {
      const seen = new Set(session.events.map((e) => `${e.contentHash}:${e.occurredAt}`));
      for (const e of patch.events) {
        if (!seen.has(`${e.contentHash}:${e.occurredAt}`)) session.events.push(e);
      }
    }
    return session;
  },

  close(id: string, commitSha?: string): AuthoringSession | undefined {
    const session = rows.get(id);
    if (!session) return undefined;
    session.endedAt = new Date().toISOString();
    if (commitSha) session.commitShas.push(commitSha);
    return session;
  },

  attachCommit(id: string, sha: string): void {
    rows.get(id)?.commitShas.push(sha);
  },

  /** An author's account of a paste. Stored as a claim, never as observation. */
  annotate(sessionId: string, contentHash: string, note: string): InputEventRecord | undefined {
    const event = rows.get(sessionId)?.events.find((e) => e.contentHash === contentHash);
    if (!event) return undefined;
    event.authorNote = note;
    event.authorNotedAt = new Date().toISOString();
    return event;
  },

  /**
   * Newest first. Ordered by insertion rather than by `startedAt`: the
   * timestamp only has millisecond precision, so two sessions opened in the
   * same millisecond would sort arbitrarily.
   */
  forRepo: (repoId: string) =>
    [...rows.values()].filter((s) => s.repoId === repoId).reverse(),
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
