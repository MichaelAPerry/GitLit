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
export const LEXICAL_SCORER_VERSION = "novelty/lexical-v1";
export const HYBRID_SCORER_VERSION = "novelty/hybrid-v2";

/** Kept for stored reports written before semantic scoring existed. */
export const SCORER_VERSION = LEXICAL_SCORER_VERSION;

/**
 * Semantic scoring runs on the pinned local model (@gitlit/embed).
 *
 * It is combined with the lexical score rather than replacing it. The two
 * answer different questions — lexical asks whether the same words appear,
 * semantic asks whether the same book is being described — and a premise can
 * be derivative in either direction. "A lighthouse keeper's daughter comes
 * home" and "the child of a beacon warden returns" share almost no words.
 *
 * Both halves are reproducible offline: the lexical score exactly, and the
 * semantic score bit-identically under the pinned WASM runtime (§2.7).
 */

export type Verdict = "sparse_prior_art" | "crowded_field" | "derivative";

export interface NearestWork {
  title: string;
  authors: string[];
  year?: number;
  /** The blended score the verdict used. */
  similarity: number;
  /** Word overlap alone. Exactly reproducible. */
  lexical: number;
  /** Meaning overlap, when the pinned model was available. */
  semantic?: number;
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
  /** Present only when the pinned model was available. */
  semantic?: {
    embedderId: string;
    weightsHash: string;
    maxSimilarity: number;
  };
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
  return assemble(premise, scored.map((s) => ({ ...s, lexical: s.score })), now, LEXICAL_SCORER_VERSION);
}

/**
 * Blend of word overlap and meaning overlap.
 *
 * Weighted toward semantic because that is what the lexical half cannot see:
 * a premise rewritten in different words is still the same premise, and an
 * author deserves to be told so. Lexical still carries weight so that
 * near-verbatim reuse cannot be hidden behind paraphrase either.
 */
const SEMANTIC_WEIGHT = 0.65;

export async function scoreNoveltySemantic(
  premise: string,
  works: Work[],
  embedder: { id: string; weightsHash: string; embed(texts: string[]): Promise<Float32Array[]> },
  cosineOf: (a: Float32Array, b: Float32Array) => number,
  now = new Date(),
): Promise<NoveltyScores> {
  const blurbs = works.map((w) => [w.title, w.synopsis ?? ""].join(". ").trim());
  const [premiseVector, ...workVectors] = await embedder.embed([premise, ...blurbs]);

  const scored = works.map((work, i) => {
    const lexical = scoreAgainst(premise, work);
    const vector = workVectors[i];
    const semantic = vector && premiseVector ? cosineOf(premiseVector, vector) : undefined;
    const score = semantic === undefined
      ? lexical
      : Number((semantic * SEMANTIC_WEIGHT + lexical * (1 - SEMANTIC_WEIGHT)).toFixed(4));
    return { work, score, lexical, semantic };
  }).sort((a, b) => b.score - a.score);

  const assembled = assemble(premise, scored, now, HYBRID_SCORER_VERSION);
  return {
    ...assembled,
    semantic: {
      embedderId: embedder.id,
      weightsHash: embedder.weightsHash,
      maxSimilarity: Math.max(0, ...scored.map((s) => s.semantic ?? 0)),
    },
  };
}

interface ScoredWork { work: Work; score: number; lexical: number; semantic?: number }

function assemble(
  premise: string, scored: ScoredWork[], now: Date, scorerVersion: string,
): NoveltyScores {
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
    scorerVersion,
    corpusSimilarity: Number(corpusSimilarity.toFixed(4)),
    conceptOverlap: Number(conceptOverlap.toFixed(4)),
    marketDensity,
    suggestedVerdict,
    nearestWorks: top.slice(0, 8).map((s) => ({
      title: s.work.title,
      authors: s.work.authors,
      year: s.work.publishedYear,
      similarity: Number(s.score.toFixed(4)),
      lexical: Number(s.lexical.toFixed(4)),
      semantic: s.semantic,
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
