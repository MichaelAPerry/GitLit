import { describe, expect, it } from "vitest";
import { diffProse, diffWords } from "./prose-diff.js";
import { diffSequences } from "./myers.js";
import { similarity, containment } from "./similarity.js";

describe("diffSequences", () => {
  it("finds no ops for identical input", () => {
    const ops = diffSequences([1, 2, 3], [1, 2, 3], (a, b) => a === b);
    expect(ops.every((o) => o.kind === "equal")).toBe(true);
  });

  it("reports a single insertion", () => {
    const ops = diffSequences(["a", "c"], ["a", "b", "c"], (a, b) => a === b);
    expect(ops.filter((o) => o.kind === "insert")).toHaveLength(1);
    expect(ops.filter((o) => o.kind === "delete")).toHaveLength(0);
  });

  it("reports a single deletion", () => {
    const ops = diffSequences(["a", "b", "c"], ["a", "c"], (a, b) => a === b);
    expect(ops.filter((o) => o.kind === "delete")).toHaveLength(1);
  });

  it("handles empty sides", () => {
    expect(diffSequences([], ["a"], (a, b) => a === b)).toEqual([{ kind: "insert", b: 0 }]);
    expect(diffSequences(["a"], [], (a, b) => a === b)).toEqual([{ kind: "delete", a: 0 }]);
  });
});

describe("diffProse", () => {
  it("sees no change in identical prose", () => {
    const text = "The lighthouse was dark. She counted the winters.";
    expect(diffProse(text, text).stats).toMatchObject({ added: 0, removed: 0, modified: 0 });
  });

  it("detects a one-word edit as a modification, not a rewrite", () => {
    const base = "The lighthouse had been dark for eleven years.";
    const head = "The lighthouse had been dark for twelve years.";
    const d = diffProse(base, head);
    expect(d.stats).toMatchObject({ modified: 1, added: 0, removed: 0 });
    const words = d.changes[0]!.words!;
    expect(words.filter((w) => w.kind === "removed").map((w) => w.text.trim())).toEqual(["eleven"]);
    expect(words.filter((w) => w.kind === "added").map((w) => w.text.trim())).toEqual(["twelve"]);
  });

  it("does not repaint a paragraph when one sentence changes", () => {
    const base = "One stayed. Two stayed. Three changed here. Four stayed.";
    const head = "One stayed. Two stayed. Three changed there. Four stayed.";
    const d = diffProse(base, head);
    expect(d.stats.unchanged).toBe(3);
    expect(d.stats.modified).toBe(1);
  });

  it("detects a moved sentence rather than an add plus a delete", () => {
    const base = "Alpha sentence here. Beta sentence here. Gamma sentence here.";
    const head = "Gamma sentence here. Alpha sentence here. Beta sentence here.";
    const d = diffProse(base, head);
    expect(d.stats.moved).toBeGreaterThan(0);
    expect(d.stats.added).toBe(0);
    expect(d.stats.removed).toBe(0);
  });

  it("reports pure additions", () => {
    const d = diffProse("One here.", "One here. Two appeared.");
    expect(d.stats).toMatchObject({ added: 1, removed: 0, modified: 0 });
  });

  it("reports pure removals", () => {
    const d = diffProse("One here. Two vanished.", "One here.");
    expect(d.stats).toMatchObject({ removed: 1, added: 0, modified: 0 });
  });

  it("ignores headings and code when diffing prose", () => {
    const base = "# Chapter One\n\nThe tide came in.";
    const head = "# Chapter Two\n\nThe tide came in.";
    expect(diffProse(base, head).stats).toMatchObject({ added: 0, removed: 0, modified: 0 });
  });
});

describe("diffWords", () => {
  it("marks only the changed word", () => {
    const runs = diffWords("a quick brown fox", "a quick red fox");
    expect(runs.filter((r) => r.kind === "removed").map((r) => r.text)).toEqual(["brown"]);
    expect(runs.filter((r) => r.kind === "added").map((r) => r.text)).toEqual(["red"]);
  });
});

describe("similarity", () => {
  it("is 1 for identical text", () => {
    expect(similarity("the tide came in", "the tide came in")).toBe(1);
  });
  it("is 0 for disjoint text", () => {
    expect(similarity("alpha beta", "gamma delta")).toBe(0);
  });
  it("is high for a one-word change", () => {
    expect(similarity("the tide came in fast", "the tide came in slow")).toBeGreaterThan(0.7);
  });
  it("ignores case and punctuation", () => {
    expect(similarity("The Tide, came in!", "the tide came in")).toBe(1);
  });
});

describe("containment", () => {
  it("detects near-verbatim carryover", () => {
    expect(containment("the lighthouse was dark", "I wrote that the lighthouse was dark today"))
      .toBeGreaterThan(0.9);
  });
  it("is low for unrelated text", () => {
    expect(containment("the lighthouse was dark", "a completely separate idea")).toBeLessThan(0.2);
  });
});
