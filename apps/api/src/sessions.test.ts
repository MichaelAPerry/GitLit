import { describe, expect, it } from "vitest";
import { authoringSessions, evidenceFor, type InputEventRecord } from "./sessions.js";

const open = (path = "manuscript/chapters/01.md") =>
  authoringSessions.open({ repoId: "repo_1", userId: "u_1", path, client: "write_web" });

const event = (over: Partial<InputEventRecord> = {}): InputEventRecord => ({
  inputMode: "pasted", charCount: 900, wordCount: 150,
  contentHash: "abc123", isTrusted: true, occurredAt: "2026-09-19T10:00:00Z", ...over,
});

describe("authoring sessions", () => {
  it("persists what the endpoint accepts — the whole point of this module", () => {
    const s = open();
    authoringSessions.update(s.id, { keystrokes: 812, events: [event()] });
    const stored = authoringSessions.get(s.id)!;
    expect(stored.keystrokes).toBe(812);
    expect(stored.events).toHaveLength(1);
  });

  it("returns undefined for an unknown session instead of pretending to record", () => {
    expect(authoringSessions.update("as_nope", { keystrokes: 1 })).toBeUndefined();
    expect(authoringSessions.get("as_nope")).toBeUndefined();
  });

  it("replaces aggregates but appends events", () => {
    const s = open();
    authoringSessions.update(s.id, { keystrokes: 100, events: [event()] });
    authoringSessions.update(s.id, {
      keystrokes: 250, events: [event({ contentHash: "def456", occurredAt: "2026-09-19T10:05:00Z" })],
    });
    const stored = authoringSessions.get(s.id)!;
    expect(stored.keystrokes).toBe(250);
    expect(stored.events).toHaveLength(2);
  });

  it("does not double-record a replayed event", () => {
    const s = open();
    authoringSessions.update(s.id, { events: [event()] });
    authoringSessions.update(s.id, { events: [event()] });
    expect(authoringSessions.get(s.id)!.events).toHaveLength(1);
  });

  it("stores no pasted text, only its hash", () => {
    const s = open();
    authoringSessions.update(s.id, { events: [event()] });
    expect(JSON.stringify(authoringSessions.get(s.id))).not.toMatch(/lighthouse|lorem/i);
    expect(authoringSessions.get(s.id)!.events[0]!.contentHash).toBe("abc123");
  });

  it("records an author note as a claim, timestamped separately", () => {
    const s = open();
    authoringSessions.update(s.id, { events: [event()] });
    const annotated = authoringSessions.annotate(s.id, "abc123", "From my Scrivener draft");
    expect(annotated?.authorNote).toBe("From my Scrivener draft");
    expect(annotated?.authorNotedAt).toBeTruthy();
  });

  it("does not annotate an event that was never recorded", () => {
    const s = open();
    expect(authoringSessions.annotate(s.id, "nope", "mine")).toBeUndefined();
  });

  it("closes with an end time and links the commit", () => {
    const s = open();
    authoringSessions.close(s.id, "abc1234");
    const stored = authoringSessions.get(s.id)!;
    expect(stored.endedAt).toBeTruthy();
    expect(stored.commitShas).toContain("abc1234");
  });

  it("lists a repo's sessions newest first", () => {
    const repoId = `repo_${Math.random()}`;
    const a = authoringSessions.open({ repoId, userId: "u", path: "p", client: "write_web" });
    const b = authoringSessions.open({ repoId, userId: "u", path: "p", client: "write_web" });
    const listed = authoringSessions.forRepo(repoId).map((s) => s.id);
    expect(listed).toContain(a.id);
    expect(listed[0]).toBe(b.id);
  });
});

describe("evidenceFor", () => {
  it("derives evidence from what was recorded, not from client claims", () => {
    const s = open();
    authoringSessions.update(s.id, { keystrokes: 4210, events: [event({ wordCount: 150 })] });
    const evidence = evidenceFor(authoringSessions.get(s.id)!);
    expect(evidence).toContain("keystrokes:4210");
    expect(evidence).toContain("pasted:150");
    expect(evidence).toContain("client:write_web");
  });

  it("sums words per input mode", () => {
    const s = open();
    authoringSessions.update(s.id, { events: [
      event({ wordCount: 100 }),
      event({ wordCount: 50, contentHash: "b", occurredAt: "2026-09-19T11:00:00Z" }),
      event({ inputMode: "dictated", wordCount: 30, contentHash: "c", occurredAt: "2026-09-19T12:00:00Z" }),
    ]});
    const evidence = evidenceFor(authoringSessions.get(s.id)!);
    expect(evidence).toContain("pasted:150");
    expect(evidence).toContain("dictated:30");
  });

  it("flags untrusted synthetic input", () => {
    const s = open();
    authoringSessions.update(s.id, {
      events: [event({ inputMode: "synthetic", isTrusted: false })],
    });
    expect(evidenceFor(authoringSessions.get(s.id)!)).toContain("synthetic_input_observed");
  });

  it("does not flag dictation or IME composition as suspicious", () => {
    const s = open();
    authoringSessions.update(s.id, { events: [
      event({ inputMode: "dictated", contentHash: "d1" }),
      event({ inputMode: "composed", contentHash: "d2", occurredAt: "2026-09-19T13:00:00Z" }),
    ]});
    const evidence = evidenceFor(authoringSessions.get(s.id)!);
    expect(evidence.some((e) => /synthetic|suspicious|flag/.test(e))).toBe(false);
  });
});
