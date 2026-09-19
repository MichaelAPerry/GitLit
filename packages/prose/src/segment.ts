import { ALWAYS_MERGE, AMBIGUOUS, DOTTED, isInitial } from "./abbreviations.js";

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("en", { granularity: "sentence" })
    : null;

/** Last dot-terminated token of a chunk, without the trailing period. */
function trailingToken(text: string): string | null {
  const m = /([\p{L}.]+)\.\s*$/u.exec(text.trimEnd());
  return m?.[1] ?? null;
}

function startsLowercase(text: string): boolean {
  const m = /^\s*["'“‘(\[]*(\p{L})/u.exec(text);
  return m ? m[1]! === m[1]!.toLowerCase() && m[1]! !== m[1]!.toUpperCase() : false;
}

/**
 * True when the boundary Intl.Segmenter found is a false positive and the
 * two chunks are really one sentence.
 */
function isFalseBoundary(left: string, right: string): boolean {
  const l = left.trimEnd();

  // Ellipsis mid-sentence: "She paused… then spoke."
  if (/(\.{3}|…)\s*$/.test(l) && startsLowercase(right)) return true;

  // Segmenter occasionally breaks after a closing quote mid-dialogue.
  if (/[,;:]\s*["'”’]?\s*$/.test(l)) return true;

  const tok = trailingToken(l);
  if (!tok) return false;

  if (DOTTED.has(tok)) return true;

  const bare = tok.replace(/\.$/, "");
  if (isInitial(bare)) return true;
  if (ALWAYS_MERGE.has(bare)) return true;
  if (AMBIGUOUS.has(bare) && startsLowercase(right)) return true;

  return false;
}

/** Regex fallback for runtimes without a full-ICU Intl.Segmenter. */
function naiveSegments(text: string): string[] {
  return text.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/gu) ?? [text];
}

/**
 * Split prose into sentences. Boundaries come from Intl.Segmenter, then false
 * boundaries are merged back using the abbreviation guard (§2.2). Returns
 * trimmed, non-empty sentences.
 */
export function segmentSentences(text: string): string[] {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return [];

  const raw = segmenter
    ? [...segmenter.segment(flat)].map((s) => s.segment)
    : naiveSegments(flat);

  const out: string[] = [];
  for (const chunk of raw) {
    const prev = out[out.length - 1];
    if (prev !== undefined && isFalseBoundary(prev, chunk)) {
      out[out.length - 1] = `${prev.trimEnd()} ${chunk.trimStart()}`;
    } else {
      out.push(chunk);
    }
  }
  return out.map((s) => s.trim()).filter(Boolean);
}
