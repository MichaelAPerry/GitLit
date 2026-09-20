import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";

import { eq } from "drizzle-orm";
import { schema } from "@gitlit/db";
import { initDb, db } from "./db.js";
import { authoringSessions, evidenceFor, type InputEventRecord } from "./sessions.js";

/**
 * These run against real Postgres (PGlite), so foreign keys, defaults, and
 * array/jsonb round-tripping are genuinely exercised rather than assumed.
 */
let repoId: string;
let userId: string;

beforeAll(async () => { await initDb(); });

beforeEach(async () => {
  const suffix = Math.random().toString(36).slice(2);
  userId = `u_${suffix}`;
  repoId = `repo_${suffix}`;
  await db().insert(schema.users).values({
    id: userId, handle: userId, email: `${userId}@example.com`,
  });
  await db().insert(schema.repositories).values({
    id: repoId, ownerUserId: userId, slug: repoId, title: "B", form: "novel", storagePath: "/x",
  });
});

const open = (path = "manuscript/chapters/01.md") =>
  authoringSessions.open({ repoId, userId, path, client: "write_web" });

const get = async (id: string) => (await authoringSessions.get(id))!;

const event = (over: Partial<InputEventRecord> = {}): InputEventRecord => ({
  inputMode: "pasted", charCount: 900, wordCount: 150,
  contentHash: "abc123", isTrusted: true, occurredAt: "2026-09-20T10:00:00Z", ...over,
});

describe("authoring sessions", () => {
  it("persists what the endpoint accepts — the whole point of this module", async () => {
    const s = await open();
    await authoringSessions.update(s.id, { keystrokes: 812, events: [event()] });
    const stored = await get(s.id);
    expect(stored.keystrokes).toBe(812);
    expect(stored.events).toHaveLength(1);
  });

  it("returns undefined for an unknown session instead of pretending to record", async () => {
    expect(await authoringSessions.update("as_nope", { keystrokes: 1 })).toBeUndefined();
    expect(await authoringSessions.get("as_nope")).toBeUndefined();
  });

  it("replaces aggregates but appends events", async () => {
    const s = await open();
    await authoringSessions.update(s.id, { keystrokes: 100, events: [event()] });
    await authoringSessions.update(s.id, {
      keystrokes: 250,
      events: [event({ contentHash: "def456", occurredAt: "2026-09-20T10:05:00Z" })],
    });
    const stored = await get(s.id);
    expect(stored.keystrokes).toBe(250);
    expect(stored.events).toHaveLength(2);
  });

  it("does not double-record a replayed event", async () => {
    const s = await open();
    await authoringSessions.update(s.id, { events: [event()] });
    await authoringSessions.update(s.id, { events: [event()] });
    expect((await get(s.id)).events).toHaveLength(1);
  });

  it("stores no pasted text, only its hash", async () => {
    const s = await open();
    await authoringSessions.update(s.id, { events: [event()] });
    const stored = await get(s.id);
    expect(JSON.stringify(stored)).not.toMatch(/lighthouse|lorem/i);
    expect(stored.events[0]!.contentHash).toBe("abc123");
  });

  it("gives every input event an expiry — the record is evidence, not a permanent log", async () => {
    const s = await open();
    await authoringSessions.update(s.id, { events: [event()] });
    const [row] = await db().select().from(schema.inputEvents)
      .where(eq(schema.inputEvents.sessionId, s.id));
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("records an author note as a claim, timestamped separately", async () => {
    const s = await open();
    await authoringSessions.update(s.id, { events: [event()] });
    const annotated = await authoringSessions.annotate(s.id, "abc123", "From my Scrivener draft");
    expect(annotated?.authorNote).toBe("From my Scrivener draft");
    expect(annotated?.authorNotedAt).toBeTruthy();
  });

  it("does not annotate an event that was never recorded", async () => {
    const s = await open();
    expect(await authoringSessions.annotate(s.id, "nope", "mine")).toBeUndefined();
  });

  it("closes with an end time and links the commit", async () => {
    const s = await open();
    await authoringSessions.close(s.id, "abc1234");
    const stored = await get(s.id);
    expect(stored.endedAt).toBeTruthy();
    expect(stored.commitShas).toContain("abc1234");
  });

  it("lists a repo's sessions newest first", async () => {
    const a = await open();
    const b = await open();
    const listed = (await authoringSessions.forRepo(repoId)).map((s) => s.id);
    expect(listed).toContain(a.id);
    expect(listed[0]).toBe(b.id);
  });

  it("survives a fresh read — the data is in Postgres, not process memory", async () => {
    const s = await open();
    await authoringSessions.update(s.id, { keystrokes: 4210, events: [event()] });
    const [row] = await db().select().from(schema.authoringSessions)
      .where(eq(schema.authoringSessions.id, s.id));
    expect(row!.keystrokes).toBe(4210);
    expect(row!.repoId).toBe(repoId);
  });
});

describe("evidenceFor", () => {
  it("derives evidence from what was recorded, not from client claims", async () => {
    const s = await open();
    await authoringSessions.update(s.id, { keystrokes: 4210, events: [event({ wordCount: 150 })] });
    const evidence = evidenceFor(await get(s.id));
    expect(evidence).toContain("keystrokes:4210");
    expect(evidence).toContain("pasted:150");
    expect(evidence).toContain("client:write_web");
  });

  it("sums words per input mode", async () => {
    const s = await open();
    await authoringSessions.update(s.id, { events: [
      event({ wordCount: 100 }),
      event({ wordCount: 50, contentHash: "b", occurredAt: "2026-09-20T11:00:00Z" }),
      event({ inputMode: "dictated", wordCount: 30, contentHash: "c", occurredAt: "2026-09-20T12:00:00Z" }),
    ] });
    const evidence = evidenceFor(await get(s.id));
    expect(evidence).toContain("pasted:150");
    expect(evidence).toContain("dictated:30");
  });

  it("flags untrusted synthetic input", async () => {
    const s = await open();
    await authoringSessions.update(s.id, {
      events: [event({ inputMode: "synthetic", isTrusted: false })],
    });
    expect(evidenceFor(await get(s.id))).toContain("synthetic_input_observed");
  });

  it("does not flag dictation or IME composition as suspicious", async () => {
    const s = await open();
    await authoringSessions.update(s.id, { events: [
      event({ inputMode: "dictated", contentHash: "d1" }),
      event({ inputMode: "composed", contentHash: "d2", occurredAt: "2026-09-20T13:00:00Z" }),
    ] });
    expect(evidenceFor(await get(s.id)).some((e) => /synthetic|suspicious|flag/.test(e))).toBe(false);
  });
});
