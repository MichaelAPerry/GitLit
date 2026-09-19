import { similarity, containment, tokens } from "@gitlit/diff";
import type { Work } from "./corpora.js";

/**
 * Novelty scoring (§8.3).
 *
 * CRITICAL PROPERTY (§2.7): these numbers must be reproducible offline,
 * forever, by anyone holding a clone. A receipt asserting "0.71 similarity" is
 * worthless if the figure came from a hosted API that answers differently next
 * year. So scoring uses only deterministic local computation.
 *
 * The scorer is versioned and the version is recorded with the report, so
 * changing it later cannot silently restate what a past verdict meant.
 */
export const SCORER_VERSION = "novelty/lexical-v1";

/**
 * The embedding slot (§4) is defined but not yet filled: the pinned local
 * bge-small ONNX model is Phase 5 work. Until it lands, scoring is lexical
 * only, and callers must present it as such rather than implying semantic
 * comparison. An interface here keeps the eventual swap honest — the model
 * identifier and weights hash become part of the recorded score.
 */
export interface Embedder {
  id: string;
  weightsHash: string;
  embed(texts: string[]): Promise<number[][]>;
}

export type Verdict = "sparse_prior_art" | "crowded_field" | "derivative";

export interface NearestWork {
  title: string;
  authors: string[];
  year?: number;
  similarity: number;
  source: string;
  url?: string;
}

export interface NoveltyScores {
  scorerVersion: string;
  corpusSimilarity: number;
  conceptOverlap: number;
  marketDensity: number;
  suggestedVerdict: Verdict;
  nearestWorks: NearestWork[];
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "of", "in", "on", "at", "to", "for",
  "with", "by", "from", "as", "is", "are", "was", "were", "be", "been", "her",
  "his", "its", "their", "who", "that", "this", "it", "she", "he", "they",
]);

export const concepts = (text: string): Set<string> =>
  new Set(tokens(text).filter((t) => t.length > 3 && !STOP.has(t)));

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Blend of token overlap and n-gram containment against a work's blurb. */
function scoreAgainst(premise: string, work: Work): number {
  const blurb = [work.title, work.synopsis ?? ""].join(". ");
  if (!blurb.trim()) return 0;
  return Math.max(similarity(premise, blurb), containment(blurb, premise, 6)) * 0.5
       + jaccard(concepts(premise), concepts(blurb)) * 0.5;
}

export function scoreNovelty(premise: string, works: Work[], now = new Date()): NoveltyScores {
  const scored = works
    .map((w) => ({ work: w, score: scoreAgainst(premise, w) }))
    .sort((a, b) => b.score - a.score);

  const top = scored.slice(0, 50);
  const corpusSimilarity = top[0]?.score ?? 0;
  const conceptOverlap = top.length
    ? top.slice(0, 10).reduce((n, s) => n + jaccard(concepts(premise), concepts(
        [s.work.title, s.work.synopsis ?? ""].join(". "))), 0) / Math.min(10, top.length)
    : 0;

  const cutoff = now.getFullYear() - 5;
  const marketDensity = scored.filter(
    (s) => s.score > 0.35 && (s.work.publishedYear ?? 0) >= cutoff,
  ).length;

  let suggestedVerdict: Verdict = "sparse_prior_art";
  if (corpusSimilarity >= 0.75) suggestedVerdict = "derivative";
  else if (corpusSimilarity >= 0.5 || marketDensity >= 5) suggestedVerdict = "crowded_field";

  return {
    scorerVersion: SCORER_VERSION,
    corpusSimilarity: Number(corpusSimilarity.toFixed(4)),
    conceptOverlap: Number(conceptOverlap.toFixed(4)),
    marketDensity,
    suggestedVerdict,
    nearestWorks: top.slice(0, 8).map((s) => ({
      title: s.work.title,
      authors: s.work.authors,
      year: s.work.publishedYear,
      similarity: Number(s.score.toFixed(4)),
      source: s.work.source,
      url: s.work.url,
    })),
  };
}

/**
 * The caveat that must accompany every verdict (§3). A "sparse prior art"
 * result means we found no close match in these corpora on this date — it is
 * not a finding of originality, and ideas are not protectable regardless.
 */
export function noveltyCaveat(corpora: string[], failed: string[]): string {
  let text =
    `Searched: ${corpora.join(", ")} on ${new Date().toISOString().slice(0, 10)}. ` +
    `Absence of found prior art is not originality: unpublished and non-English ` +
    `works are poorly represented in these corpora, and ideas are not protectable.`;
  if (failed.length > 0) {
    text += ` NOTE: ${failed.join(", ")} did not respond, so this search was partial.`;
  }
  return text;
}
