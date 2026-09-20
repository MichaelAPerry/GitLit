import { normalize, segmentSentences, splitBlocks, type ParsedBeat } from "@gitlit/prose";
import { containment, similarity } from "./similarity.js";

/**
 * Mode A — Plan vs. Prose (§9.1), the flagship view.
 *
 * Answers one question per paragraph and per beat: did this prose descend
 * from the plan, and how far has it moved? The interesting cells are
 * `unplanned` and `abandoned` — those are precisely where the author
 * asserted themselves against the outline, and the view should draw the eye
 * to them rather than to the faithful stretches.
 *
 * Deterministic and local (§2.7). Declared links and lexical overlap only —
 * every number here must be reproducible offline from a clone, forever, so
 * nothing may route through a hosted model.
 */

export type Relation = "faithful" | "developed" | "departed" | "unplanned" | "abandoned";

/** How a link was established. `declared` is the author's own front matter. */
export type Method = "declared" | "lexical";

export interface Paragraph {
  index: number;
  text: string;
  wordCount: number;
  /** Beat ids named in the chapter's front matter. */
  declaredBeats: string[];
}

export interface Derivation {
  beatId?: string;
  paraIndex?: number;
  relation: Relation;
  similarity: number;
  /** Paragraph length relative to its beat; only set for a matched pair. */
  expansion?: number;
  method: Method;
}

export interface Divergence {
  /** Share of prose, by word count, that left the plan or was never in it. */
  score: number;
  departedWords: number;
  unplannedWords: number;
  plannedWords: number;
  totalWords: number;
}

export interface PlanDiff {
  derivations: Derivation[];
  divergence: Divergence;
  counts: Record<Relation, number>;
  algoVersion: string;
}

export const DERIVATION_ALGO_VERSION = "derivation/lexical-v1";

/** §9.1 thresholds. Versioned with the algorithm so a change cannot restate the past. */
export const THRESHOLDS = {
  faithful: 0.8,
  developed: 0.55,
  /** Below this, no beat plausibly relates — the prose is unplanned, not merely departed. */
  match: 0.25,
  /**
   * How much longer than its beat a paragraph may run and still count as
   * following the plan rather than growing it. Retention alone cannot tell
   * those apart: containment asks how much of the BEAT survives, so a beat
   * quoted verbatim plus three added sentences still scores ~1.0.
   */
  expansion: 1.75,
} as const;

/** Paragraphs of a chapter, with any beat ids the author declared up front. */
export function paragraphsOf(source: string): Paragraph[] {
  const declared = declaredBeats(source);
  const blocks = splitBlocks(normalize(source));
  const paragraphs: Paragraph[] = [];

  for (const block of blocks) {
    if (block.kind !== "paragraph") continue;
    const text = block.lines.join(" ").trim();
    if (!text) continue;
    paragraphs.push({
      index: paragraphs.length,
      text,
      wordCount: (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length,
      declaredBeats: declared,
    });
  }
  return paragraphs;
}

function declaredBeats(source: string): string[] {
  const fm = /^---\n([\s\S]*?)\n---/.exec(source);
  if (!fm) return [];
  const line = /^beats:\s*\[(.*)\]\s*$/m.exec(fm[1]!);
  if (!line) return [];
  return line[1]!.split(",").map((b) => b.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

export interface PairScore {
  /** How much of the beat's language survives into the paragraph. */
  retention: number;
  /** Paragraph length relative to its beat. Above 1 means the author grew it. */
  expansion: number;
}

/**
 * Score one beat against one paragraph.
 *
 * A beat is a terse instruction ("Mara drives the headland road") and a
 * paragraph is finished prose, so the two are never near-identical even when
 * one plainly realises the other. Containment carries the signal — how much of
 * the beat's language survives — with token overlap as support.
 *
 * Expansion is reported separately because retention cannot see it. Both are
 * needed to tell "wrote the beat" from "wrote the beat and then kept going",
 * which is the distinction the flagship view exists to show.
 */
export function scorePair(beat: ParsedBeat, paragraph: Paragraph): number {
  return pairScore(beat, paragraph).retention;
}

export function pairScore(beat: ParsedBeat, paragraph: Paragraph): PairScore {
  const retention = Math.max(
    containment(beat.text, paragraph.text, 4),
    similarity(beat.text, paragraph.text),
  );
  const beatWords = (beat.text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
  return {
    retention: Number(retention.toFixed(4)),
    expansion: beatWords === 0 ? 1 : Number((paragraph.wordCount / beatWords).toFixed(4)),
  };
}

function classify(score: PairScore): Relation {
  // The plan's language largely survives AND the paragraph stayed close to the
  // beat's length: the author followed it.
  if (score.retention >= THRESHOLDS.faithful && score.expansion <= THRESHOLDS.expansion) {
    return "faithful";
  }
  // Either the beat survives but has grown well past its original scope, or it
  // partly survives. Both are the author developing the plan rather than
  // reproducing or leaving it.
  if (score.retention >= THRESHOLDS.developed) return "developed";
  return "departed";
}

/**
 * Compare a chapter against the beats planned for it.
 *
 * Deliberately NOT a one-to-one assignment, which is what the architecture
 * sketch proposed. Prose does not map to an outline one-for-one: a single
 * beat is often realised across three paragraphs, and forcing a bijection
 * would mark two of them `unplanned` and inflate divergence with an artefact
 * of the matching, not of the writing. Each side takes its best partner
 * independently.
 */
export function diffPlanToProse(beats: ParsedBeat[], paragraphs: Paragraph[]): PlanDiff {
  const derivations: Derivation[] = [];
  const matchedBeats = new Set<string>();

  for (const paragraph of paragraphs) {
    let best: { beat: ParsedBeat; score: PairScore; method: Method } | null = null;

    for (const beat of beats) {
      const lexical = pairScore(beat, paragraph);
      // A declared link is the author's own statement of intent and outranks
      // whatever the text happens to share; it cannot be outscored away.
      const isDeclared = paragraph.declaredBeats.includes(beat.id);
      const score: PairScore = isDeclared
        ? { ...lexical, retention: Math.max(lexical.retention, THRESHOLDS.developed) }
        : lexical;
      const method: Method = isDeclared ? "declared" : "lexical";

      if (
        !best ||
        score.retention > best.score.retention ||
        (score.retention === best.score.retention && method === "declared")
      ) {
        best = { beat, score, method };
      }
    }

    if (!best || best.score.retention < THRESHOLDS.match) {
      derivations.push({
        paraIndex: paragraph.index, relation: "unplanned",
        similarity: best?.score.retention ?? 0, method: "lexical",
      });
      continue;
    }

    matchedBeats.add(best.beat.id);
    derivations.push({
      beatId: best.beat.id,
      paraIndex: paragraph.index,
      relation: classify(best.score),
      similarity: best.score.retention,
      expansion: best.score.expansion,
      method: best.method,
    });
  }

  for (const beat of beats) {
    if (matchedBeats.has(beat.id)) continue;
    derivations.push({ beatId: beat.id, relation: "abandoned", similarity: 0, method: "lexical" });
  }

  return {
    derivations,
    divergence: computeDivergence(derivations, paragraphs),
    counts: countRelations(derivations),
    algoVersion: DERIVATION_ALGO_VERSION,
  };
}

/**
 * The headline metric (§9.1): how much of the finished prose left the plan.
 *
 * Weighted by word count, not paragraph count — a one-line unplanned aside and
 * a thousand-word unplanned chapter are not the same claim about a book.
 */
export function computeDivergence(derivations: Derivation[], paragraphs: Paragraph[]): Divergence {
  const words = new Map(paragraphs.map((p) => [p.index, p.wordCount]));
  let departedWords = 0;
  let unplannedWords = 0;
  let plannedWords = 0;

  for (const d of derivations) {
    if (d.paraIndex === undefined) continue;
    const n = words.get(d.paraIndex) ?? 0;
    if (d.relation === "departed") departedWords += n;
    else if (d.relation === "unplanned") unplannedWords += n;
    else plannedWords += n;
  }

  const totalWords = departedWords + unplannedWords + plannedWords;
  return {
    score: totalWords === 0 ? 0 : Number(((departedWords + unplannedWords) / totalWords).toFixed(4)),
    departedWords,
    unplannedWords,
    plannedWords,
    totalWords,
  };
}

function countRelations(derivations: Derivation[]): Record<Relation, number> {
  const counts: Record<Relation, number> = {
    faithful: 0, developed: 0, departed: 0, unplanned: 0, abandoned: 0,
  };
  for (const d of derivations) counts[d.relation] += 1;
  return counts;
}

/** Beats planned for one chapter, by the `[chN]` id in the architecture. */
export function beatsForChapter(beats: ParsedBeat[], chapterId: string): ParsedBeat[] {
  return beats.filter((b) => b.chapterId === chapterId);
}

/**
 * Guess which chapter a manuscript path corresponds to, for repos whose
 * chapters carry no explicit id. "01-the-lighthouse.md" -> "ch1".
 */
export function chapterIdForPath(path: string): string | null {
  const match = /(?:^|\/)(\d{1,3})[-_]/.exec(path.split("/").pop() ?? "");
  return match ? `ch${Number(match[1])}` : null;
}

export { segmentSentences };
