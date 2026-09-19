import { createHash } from "node:crypto";
import { normalize, segmentSentences } from "@gitlit/prose";
import { diffSequences } from "./myers.js";
import { similarity } from "./similarity.js";

export type ChangeKind = "equal" | "added" | "removed" | "modified" | "moved";

export interface SentenceChange {
  kind: ChangeKind;
  /** Sentence index in the base document, when present. */
  baseIndex?: number;
  /** Sentence index in the head document, when present. */
  headIndex?: number;
  baseText?: string;
  headText?: string;
  /** Word-level runs, only for `modified`. */
  words?: WordRun[];
  /** Similarity of base to head, for `modified` and `moved`. */
  similarity?: number;
}

export interface WordRun { kind: "equal" | "added" | "removed"; text: string }

export interface ProseDiff {
  changes: SentenceChange[];
  stats: { added: number; removed: number; modified: number; moved: number; unchanged: number };
}

const REPLACE_FLOOR = 0.45;

const hash = (s: string) =>
  createHash("sha256").update(s.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);

function sentencesOf(source: string): string[] {
  return normalize(source)
    .split("\n\n")
    .flatMap((block) =>
      /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|---)/.test(block) ? [] : segmentSentences(block),
    );
}

/**
 * Sentence-level diff with move detection and word-level detail inside
 * modified sentences (§9.3).
 *
 * Move detection runs before the word diff because restructuring is most of
 * revision in prose, and a naive diff renders a moved chapter as a total
 * rewrite — which is useless to an author trying to see what they changed.
 */
export function diffProse(base: string, head: string): ProseDiff {
  const a = sentencesOf(base);
  const b = sentencesOf(head);
  const ah = a.map(hash);
  const bh = b.map(hash);

  const ops = diffSequences(ah, bh, (x, y) => x === y);

  const removed: number[] = [];
  const added: number[] = [];
  const changes: SentenceChange[] = [];

  for (const op of ops) {
    if (op.kind === "equal") {
      changes.push({ kind: "equal", baseIndex: op.a!, headIndex: op.b!, baseText: a[op.a!]!, headText: b[op.b!]! });
    } else if (op.kind === "delete") {
      removed.push(op.a!);
      changes.push({ kind: "removed", baseIndex: op.a!, baseText: a[op.a!]! });
    } else {
      added.push(op.b!);
      changes.push({ kind: "added", headIndex: op.b!, headText: b[op.b!]! });
    }
  }

  // Pass 1: identical text on both sides of the edit script is a move.
  const addedByHash = new Map<string, number[]>();
  for (const i of added) {
    const h = bh[i]!;
    (addedByHash.get(h) ?? addedByHash.set(h, []).get(h)!).push(i);
  }
  const movedBase = new Set<number>();
  const movedHead = new Set<number>();
  for (const i of removed) {
    const candidates = addedByHash.get(ah[i]!);
    const j = candidates?.shift();
    if (j !== undefined) { movedBase.add(i); movedHead.add(j); }
  }

  // Pass 2: pair remaining removals with insertions that are near-rewrites.
  const pairs = new Map<number, number>();
  const freeAdded = added.filter((j) => !movedHead.has(j));
  for (const i of removed) {
    if (movedBase.has(i)) continue;
    let best = -1;
    let bestScore = REPLACE_FLOOR;
    for (const j of freeAdded) {
      if (pairs.has(j)) continue;
      const s = similarity(a[i]!, b[j]!);
      if (s > bestScore) { bestScore = s; best = j; }
    }
    if (best >= 0) pairs.set(best, i);
  }

  const out: SentenceChange[] = [];
  const consumedRemovals = new Set([...pairs.values()]);
  for (const c of changes) {
    if (c.kind === "removed" && movedBase.has(c.baseIndex!)) {
      continue; // reported at its new position
    }
    if (c.kind === "removed" && consumedRemovals.has(c.baseIndex!)) {
      continue; // folded into the paired modification
    }
    if (c.kind === "added" && movedHead.has(c.headIndex!)) {
      out.push({ kind: "moved", headIndex: c.headIndex!, headText: c.headText!, similarity: 1 });
      continue;
    }
    if (c.kind === "added" && pairs.has(c.headIndex!)) {
      const bi = pairs.get(c.headIndex!)!;
      out.push({
        kind: "modified",
        baseIndex: bi,
        headIndex: c.headIndex!,
        baseText: a[bi]!,
        headText: c.headText!,
        words: diffWords(a[bi]!, c.headText!),
        similarity: similarity(a[bi]!, c.headText!),
      });
      continue;
    }
    out.push(c);
  }

  const stats = {
    added: out.filter((c) => c.kind === "added").length,
    removed: out.filter((c) => c.kind === "removed").length,
    modified: out.filter((c) => c.kind === "modified").length,
    moved: out.filter((c) => c.kind === "moved").length,
    unchanged: out.filter((c) => c.kind === "equal").length,
  };
  return { changes: out, stats };
}

/** Word-level runs inside one modified sentence. */
export function diffWords(base: string, head: string): WordRun[] {
  const split = (s: string) => s.split(/(\s+)/).filter((t) => t.length > 0);
  const a = split(base);
  const b = split(head);
  const ops = diffSequences(a, b, (x, y) => x === y);

  const runs: WordRun[] = [];
  const push = (kind: WordRun["kind"], text: string) => {
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.text += text;
    else runs.push({ kind, text });
  };
  for (const op of ops) {
    if (op.kind === "equal") push("equal", a[op.a!]!);
    else if (op.kind === "delete") push("removed", a[op.a!]!);
    else push("added", b[op.b!]!);
  }
  return runs;
}
