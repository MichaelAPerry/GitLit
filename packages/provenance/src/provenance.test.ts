import { describe, expect, it } from "vitest";
import type { ProvenanceSpan } from "@gitlit/core";
import { formatMessage, parseMessage } from "./trailers.js";
import {
  units, carryForwardSpans, classifyCommit, machineShare, spansDigest, toJsonl, fromJsonl,
} from "./spans.js";
import { generateSigningKey, issueReceipt, verifyReceipt, verifyChain, payloadHash } from "./receipts.js";

const ctx = (origin: ProvenanceSpan["origin"], commit = "c1") => ({
  commit, author: "u_1", newTextOrigin: origin, evidence: [], ts: "2026-09-19T00:00:00Z",
});

describe("trailers", () => {
  it("round-trips", () => {
    const msg = formatMessage("Add chapter 3", {
      provenance: "hybrid", agentSession: "sess_1", declaredModel: "claude-opus-5",
      spansDigest: "sha256:abc", evidence: ["in_platform_typing", "paste:2"], receipt: "rcpt_1",
      configVersion: "spans/v1",
    });
    const parsed = parseMessage(msg);
    expect(parsed.subject).toBe("Add chapter 3");
    expect(parsed.provenance).toBe("hybrid");
    expect(parsed.agentSession).toBe("sess_1");
    expect(parsed.evidence).toEqual(["in_platform_typing", "paste:2"]);
  });

  it("strips the unverified marker from the declared model", () => {
    const msg = formatMessage("x", { provenance: "ai", declaredModel: "claude-opus-5" });
    expect(msg).toContain("(agent claim, unverified)");
    expect(parseMessage(msg).declaredModel).toBe("claude-opus-5");
  });

  it("ignores unrelated trailer-shaped lines", () => {
    expect(parseMessage("subject\n\nCo-Authored-By: someone\n").provenance).toBeUndefined();
  });
});

describe("units", () => {
  it("gives character ranges per sentence", () => {
    const u = units("One here. Two here.");
    expect(u).toHaveLength(2);
    expect(u[0]!.text).toBe("One here.");
    expect(u[1]!.start).toBe(u[0]!.end + 1);
  });
});

describe("carryForwardSpans", () => {
  const aiDraft = "The lighthouse stood alone. The keeper had gone.";

  it("marks all-new text with the given origin", () => {
    const spans = carryForwardSpans("", aiDraft, [], ctx("ai_generated"));
    expect(spans).toHaveLength(1);
    expect(spans[0]!.origin).toBe("ai_generated");
  });

  it("preserves provenance of untouched sentences", () => {
    const first = carryForwardSpans("", aiDraft, [], ctx("ai_generated"));
    const edited = "The lighthouse stood alone. The keeper had gone. She arrived at noon.";
    const next = carryForwardSpans(aiDraft, edited, first, ctx("human_written", "c2"));
    expect(next.find((s) => s.origin === "ai_generated")).toBeDefined();
    expect(next.find((s) => s.origin === "human_written")).toBeDefined();
  });

  it("reclassifies a light edit of AI text as human_edited_ai", () => {
    const first = carryForwardSpans("", aiDraft, [], ctx("ai_generated"));
    const edited = "The lighthouse stood alone. The keeper had long gone.";
    const next = carryForwardSpans(aiDraft, edited, first, ctx("human_written", "c2"));
    const touched = next.find((s) => s.origin === "human_edited_ai");
    expect(touched).toBeDefined();
    expect(touched!.retained).toBeGreaterThan(0.8);
  });

  it("treats a total rewrite as the author's own writing", () => {
    const first = carryForwardSpans("", aiDraft, [], ctx("ai_generated"));
    const edited = "The lighthouse stood alone. Salt had eaten every rail and nobody came here now.";
    const next = carryForwardSpans(aiDraft, edited, first, ctx("human_written", "c2"));
    expect(next.some((s) => s.origin === "human_written")).toBe(true);
  });

  it("is stable when nothing changes", () => {
    const first = carryForwardSpans("", aiDraft, [], ctx("ai_generated"));
    const again = carryForwardSpans(aiDraft, aiDraft, first, ctx("human_written", "c2"));
    expect(again.every((s) => s.origin === "ai_generated")).toBe(true);
  });

  it("merges adjacent spans that agree", () => {
    const spans = carryForwardSpans("", "One. Two. Three.", [], ctx("human_written"));
    expect(spans).toHaveLength(1);
  });
});

describe("classifyCommit", () => {
  const span = (origin: ProvenanceSpan["origin"]): ProvenanceSpan =>
    ({ start: 0, end: 10, origin, evidence: [] });

  it("classes machine-only as ai", () => {
    expect(classifyCommit([span("ai_generated")])).toBe("ai");
  });
  it("classes human-only as human", () => {
    expect(classifyCommit([span("human_written")])).toBe("human");
  });
  it("classes a mix as hybrid", () => {
    expect(classifyCommit([span("ai_generated"), span("human_written")])).toBe("hybrid");
  });
  it("classes edited AI text as hybrid", () => {
    expect(classifyCommit([span("human_edited_ai")])).toBe("hybrid");
  });
  it("classes imported text as human, not machine", () => {
    expect(classifyCommit([span("imported")])).toBe("human");
  });
});

describe("machineShare", () => {
  it("is 0 for wholly human text", () => {
    expect(machineShare([{ start: 0, end: 100, origin: "human_written", evidence: [] }])).toBe(0);
  });
  it("is 1 for wholly machine text", () => {
    expect(machineShare([{ start: 0, end: 100, origin: "ai_generated", evidence: [] }])).toBe(1);
  });
  it("weights edited AI text by what was retained", () => {
    expect(machineShare([
      { start: 0, end: 100, origin: "human_edited_ai", retained: 0.4, evidence: [] },
    ])).toBeCloseTo(0.4);
  });
});

describe("sidecar", () => {
  it("round-trips through jsonl", () => {
    const spans = carryForwardSpans("", "One. Two.", [], ctx("ai_generated"));
    expect(fromJsonl(toJsonl(spans))).toEqual(spans);
  });
  it("produces a stable digest", () => {
    const a = carryForwardSpans("", "One. Two.", [], ctx("ai_generated"));
    const b = carryForwardSpans("", "One. Two.", [], ctx("ai_generated"));
    expect(spansDigest(a)).toBe(spansDigest(b));
  });
  it("changes the digest when spans change", () => {
    const a = carryForwardSpans("", "One. Two.", [], ctx("ai_generated"));
    const b = carryForwardSpans("", "One. Two.", [], ctx("human_written"));
    expect(spansDigest(a)).not.toBe(spansDigest(b));
  });
});

describe("receipts", () => {
  const key = generateSigningKey("key_1");
  const base = {
    id: "rcpt_1", repo: "repo_1", commit: "a".repeat(40),
    spansDigest: "sha256:abc", configVersion: "spans/v1",
    issuedAt: "2026-09-19T00:00:00Z", prev: null,
  };

  it("verifies a good signature", () => {
    expect(verifyReceipt(issueReceipt(base, key), key.publicKey)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const r = issueReceipt(base, key);
    expect(verifyReceipt({ ...r, commit: "b".repeat(40) }, key.publicKey)).toBe(false);
  });

  it("rejects the wrong public key", () => {
    const other = generateSigningKey("key_2");
    expect(verifyReceipt(issueReceipt(base, key), other.publicKey)).toBe(false);
  });

  it("verifies a whole chain", () => {
    const r1 = issueReceipt(base, key);
    const r2 = issueReceipt({ ...base, id: "rcpt_2", commit: "b".repeat(40), prev: payloadHash(r1) }, key);
    const result = verifyChain([r1, r2], new Map([["key_1", key.publicKey]]));
    expect(result.valid).toBe(true);
    expect(result.verified).toBe(2);
  });

  it("detects a removed commit in the middle of the chain", () => {
    const r1 = issueReceipt(base, key);
    const r2 = issueReceipt({ ...base, id: "rcpt_2", commit: "b".repeat(40), prev: payloadHash(r1) }, key);
    const r3 = issueReceipt({ ...base, id: "rcpt_3", commit: "c".repeat(40), prev: payloadHash(r2) }, key);
    const result = verifyChain([r1, r3], new Map([["key_1", key.publicKey]]));
    expect(result.valid).toBe(false);
    expect(result.failures[0]!.reason).toBe("broken_chain");
  });

  it("detects reordering", () => {
    const r1 = issueReceipt(base, key);
    const r2 = issueReceipt({ ...base, id: "rcpt_2", commit: "b".repeat(40), prev: payloadHash(r1) }, key);
    expect(verifyChain([r2, r1], new Map([["key_1", key.publicKey]])).valid).toBe(false);
  });

  it("fails closed on an unknown key", () => {
    expect(verifyChain([issueReceipt(base, key)], new Map()).valid).toBe(false);
  });
});
