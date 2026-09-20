import { describe, expect, it } from "vitest";
import { parseArchitecture, type ParsedBeat } from "@gitlit/prose";
import {
  diffPlanToProse, paragraphsOf, scorePair, computeDivergence,
  beatsForChapter, chapterIdForPath, THRESHOLDS,
} from "./derivation.js";

const beat = (id: string, text: string, chapterId = "ch1"): ParsedBeat =>
  ({ id, text, sources: [], chapterId });

describe("paragraphsOf", () => {
  it("splits a chapter into paragraphs with word counts", () => {
    const chapter = "One sentence here. And another.\n\nA second paragraph entirely.";
    const paragraphs = paragraphsOf(chapter);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]!.wordCount).toBe(5);
    expect(paragraphs[1]!.text).toBe("A second paragraph entirely.");
  });

  it("skips headings, code and front matter", () => {
    const chapter = "---\nchapter: 1\n---\n\n# The Lighthouse\n\nReal prose here.\n\n```\ncode\n```";
    const paragraphs = paragraphsOf(chapter);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]!.text).toBe("Real prose here.");
  });

  it("reads declared beat links from the front matter", () => {
    const chapter = "---\nchapter: 1\nbeats: [b1.1, b1.2]\n---\n\nSome prose.";
    expect(paragraphsOf(chapter)[0]!.declaredBeats).toEqual(["b1.1", "b1.2"]);
  });

  it("copes with quoted beat ids and no front matter", () => {
    expect(paragraphsOf('---\nbeats: ["b1.1", \'b1.2\']\n---\n\nX.')[0]!.declaredBeats)
      .toEqual(["b1.1", "b1.2"]);
    expect(paragraphsOf("Just prose.")[0]!.declaredBeats).toEqual([]);
  });
});

describe("scorePair", () => {
  it("scores near-verbatim realisation high", () => {
    const score = scorePair(
      beat("b1.1", "Mara drives the headland road, counting winters"),
      { index: 0, text: "Mara drives the headland road, counting winters.", wordCount: 7, declaredBeats: [] },
    );
    expect(score).toBeGreaterThan(THRESHOLDS.faithful);
  });

  it("scores unrelated prose low", () => {
    const score = scorePair(
      beat("b1.1", "Mara drives the headland road"),
      { index: 0, text: "Orbital vegetables require careful pressure management.", wordCount: 6, declaredBeats: [] },
    );
    expect(score).toBeLessThan(THRESHOLDS.match);
  });

  it("is deterministic", () => {
    const b = beat("b1.1", "The cottage is exactly as she left it");
    const p = { index: 0, text: "The cottage stood exactly as she had left it.", wordCount: 9, declaredBeats: [] };
    expect(scorePair(b, p)).toBe(scorePair(b, p));
  });
});

describe("diffPlanToProse", () => {
  const beats = [
    beat("b1.1", "Mara drives the headland road, counting winters"),
    beat("b1.2", "The keeper's cottage is exactly as she left it"),
  ];

  it("marks close realisation as faithful", () => {
    const paragraphs = paragraphsOf("Mara drives the headland road, counting winters.");
    const { derivations } = diffPlanToProse(beats, paragraphs);
    expect(derivations[0]).toMatchObject({ beatId: "b1.1", relation: "faithful" });
  });

  it("marks a beat the author expanded as developed", () => {
    const paragraphs = paragraphsOf(
      "The keeper's cottage was exactly as she left it, down to the salt crust on the sill.",
    );
    const { derivations } = diffPlanToProse(beats, paragraphs);
    expect(derivations[0]!.relation).toBe("developed");
  });

  it("MARKS PROSE THE PLAN NEVER CONTAINED as unplanned", () => {
    const paragraphs = paragraphsOf(
      "She thought instead about her mother's hands, and the way they shook near the end.",
    );
    const { derivations } = diffPlanToProse(beats, paragraphs);
    expect(derivations[0]).toMatchObject({ relation: "unplanned" });
    expect(derivations[0]!.beatId).toBeUndefined();
  });

  it("MARKS A BEAT NO PROSE REALISED as abandoned", () => {
    const paragraphs = paragraphsOf("Mara drives the headland road, counting winters.");
    const { derivations } = diffPlanToProse(beats, paragraphs);
    const abandoned = derivations.filter((d) => d.relation === "abandoned");
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]!.beatId).toBe("b1.2");
    expect(abandoned[0]!.paraIndex).toBeUndefined();
  });

  it("lets ONE BEAT cover several paragraphs without inflating divergence", () => {
    // A bijection would mark the later paragraphs unplanned; prose does not
    // map to an outline one-for-one.
    const chapter = [
      "Mara drives the headland road, counting winters.",
      "The headland road gave out, and Mara counted the winters again.",
      "Counting winters, Mara drove the last of the headland road.",
    ].join("\n\n");
    const { derivations, divergence } = diffPlanToProse([beats[0]!], paragraphsOf(chapter));
    const matched = derivations.filter((d) => d.beatId === "b1.1" && d.paraIndex !== undefined);
    expect(matched).toHaveLength(3);
    expect(divergence.unplannedWords).toBe(0);
  });

  it("honours a declared link even when the wording diverges", () => {
    const chapter = "---\nbeats: [b1.2]\n---\n\nSalt had eaten every rail, and nobody came here now.";
    const { derivations } = diffPlanToProse(beats, paragraphsOf(chapter));
    expect(derivations[0]!.method).toBe("declared");
    expect(derivations[0]!.beatId).toBe("b1.2");
    expect(derivations[0]!.relation).not.toBe("unplanned");
  });

  it("counts every relation", () => {
    const chapter = [
      "Mara drives the headland road, counting winters.",
      "A wholly separate thought about orbital agriculture.",
    ].join("\n\n");
    const { counts } = diffPlanToProse(beats, paragraphsOf(chapter));
    expect(counts.faithful).toBe(1);
    expect(counts.unplanned).toBe(1);
    expect(counts.abandoned).toBe(1);
  });

  it("handles an empty plan — every paragraph is the author's own", () => {
    const { derivations, divergence } = diffPlanToProse([], paragraphsOf("All mine. Every word."));
    expect(derivations.every((d) => d.relation === "unplanned")).toBe(true);
    expect(divergence.score).toBe(1);
  });

  it("handles an unwritten chapter — every beat is outstanding", () => {
    const { counts, divergence } = diffPlanToProse(beats, []);
    expect(counts.abandoned).toBe(2);
    expect(divergence.score).toBe(0);
    expect(divergence.totalWords).toBe(0);
  });

  it("records the algorithm version so a threshold change cannot restate the past", () => {
    expect(diffPlanToProse(beats, []).algoVersion).toBe("derivation/lexical-v1");
  });
});

describe("divergence", () => {
  const paragraphs = [
    { index: 0, text: "x", wordCount: 100, declaredBeats: [] },
    { index: 1, text: "y", wordCount: 900, declaredBeats: [] },
  ];

  it("WEIGHTS BY WORDS, not by paragraph count", () => {
    // One short planned paragraph and one long unplanned one is a 90%
    // divergence, not 50%.
    const d = computeDivergence([
      { paraIndex: 0, beatId: "b1.1", relation: "faithful", similarity: 0.9, method: "lexical" },
      { paraIndex: 1, relation: "unplanned", similarity: 0, method: "lexical" },
    ], paragraphs);
    expect(d.score).toBe(0.9);
    expect(d.unplannedWords).toBe(900);
  });

  it("counts departed prose as divergence too", () => {
    const d = computeDivergence([
      { paraIndex: 0, beatId: "b1.1", relation: "departed", similarity: 0.3, method: "lexical" },
      { paraIndex: 1, beatId: "b1.2", relation: "faithful", similarity: 0.9, method: "lexical" },
    ], paragraphs);
    expect(d.score).toBe(0.1);
    expect(d.departedWords).toBe(100);
  });

  it("does not let abandoned beats affect the prose-side metric", () => {
    const d = computeDivergence([
      { paraIndex: 0, beatId: "b1.1", relation: "faithful", similarity: 0.9, method: "lexical" },
      { beatId: "b9.9", relation: "abandoned", similarity: 0, method: "lexical" },
    ], [paragraphs[0]!]);
    expect(d.score).toBe(0);
    expect(d.totalWords).toBe(100);
  });

  it("is 0 for an empty manuscript rather than NaN", () => {
    expect(computeDivergence([], []).score).toBe(0);
  });
});

describe("chapter mapping", () => {
  it("selects the beats planned for one chapter", () => {
    const all = [beat("b1.1", "x", "ch1"), beat("b2.1", "y", "ch2")];
    expect(beatsForChapter(all, "ch2").map((b) => b.id)).toEqual(["b2.1"]);
  });

  it("derives a chapter id from a manuscript filename", () => {
    expect(chapterIdForPath("manuscript/chapters/01-the-lighthouse.md")).toBe("ch1");
    expect(chapterIdForPath("manuscript/chapters/12-salt.md")).toBe("ch12");
    expect(chapterIdForPath("manuscript/front-matter.md")).toBeNull();
  });
});

describe("against a real architecture document", () => {
  const ARCHITECTURE = `
## 4. Chapter Outline
### Chapter 1 — The Lighthouse \`[ch1]\`
**Beats:**
- \`b1.1\` Mara drives the headland road, counting winters. *(sources: S-001)*
- \`b1.2\` The keeper's cottage is exactly as she left it.

### Chapter 2 — Salt and Ash \`[ch2]\`
**Beats:**
- \`b2.1\` The will is read aloud in the parlour.
`;

  it("scopes the comparison to the chapter being read", () => {
    const { beats } = parseArchitecture(ARCHITECTURE);
    expect(beats).toHaveLength(3);
    const chapterOne = beatsForChapter(beats, "ch1");
    expect(chapterOne.map((b) => b.id)).toEqual(["b1.1", "b1.2"]);

    const { counts } = diffPlanToProse(
      chapterOne,
      paragraphsOf("Mara drives the headland road, counting winters."),
    );
    // Chapter 2's beat must not appear as abandoned here.
    expect(counts.abandoned).toBe(1);
  });
});

describe("expansion", () => {
  const b = beat("b1.1", "The keeper's cottage is exactly as she left it");

  it("calls a beat written close to its own length faithful", () => {
    const { derivations } = diffPlanToProse([b],
      paragraphsOf("The keeper's cottage was exactly as she left it."));
    expect(derivations[0]!.relation).toBe("faithful");
  });

  // Retention alone cannot see this: containment asks how much of the BEAT
  // survives, so a beat quoted verbatim plus added prose still scores ~1.0.
  it("calls a beat the author grew developed, even when its language survives whole", () => {
    const grown = "The keeper's cottage was exactly as she left it, down to the salt crust on " +
      "the sill and the tide chart still pinned above the stove, its corners curling in the damp.";
    const { derivations } = diffPlanToProse([b], paragraphsOf(grown));
    expect(derivations[0]!.relation).toBe("developed");
    expect(derivations[0]!.similarity).toBeGreaterThan(0.8);
    expect(derivations[0]!.expansion).toBeGreaterThan(1.75);
  });

  it("reports expansion so the view can show how far a beat grew", () => {
    const { derivations } = diffPlanToProse([b],
      paragraphsOf("The keeper's cottage was exactly as she left it."));
    expect(derivations[0]!.expansion).toBeCloseTo(1, 0);
  });
});
