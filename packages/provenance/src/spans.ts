import { createHash } from "node:crypto";
import type { ProvenanceClass, ProvenanceSpan, SpanOrigin } from "@gitlit/core";
import { normalize } from "@gitlit/prose";
import { diffSequences, similarity } from "@gitlit/diff";
import { DEFAULT_CONFIG, type ProvenanceConfig } from "./config.js";

export interface Unit { start: number; end: number; text: string }

/** Character ranges of each line in the normalized document. */
export function units(source: string): Unit[] {
  const text = normalize(source);
  const out: Unit[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length > 0) out.push({ start: offset, end: offset + line.length, text: line });
    offset += line.length + 1;
  }
  return out;
}

export interface CarryContext {
  commit?: string;
  author?: string;
  session?: string;
  declaredModel?: string;
  /** Origin assigned to text with no ancestor — decided by how it arrived. */
  newTextOrigin: SpanOrigin;
  evidence?: string[];
  config?: ProvenanceConfig;
  ts?: string;
}

function spanAt(spans: ProvenanceSpan[], u: Unit): ProvenanceSpan | undefined {
  const mid = Math.floor((u.start + u.end) / 2);
  return spans.find((s) => s.start <= mid && mid < s.end);
}

/**
 * Recompute spans for a new revision (§7.3).
 *
 * Unchanged sentences keep their provenance. Edited sentences are re-classified
 * by how much of the original survives: heavy retention of AI-origin text stays
 * attributed as AI-derived, a near-total rewrite becomes the author's own.
 *
 * Thresholds come from a versioned config that is stamped onto the commit, so
 * changing them later cannot retroactively alter what past history claims.
 */
export function carryForwardSpans(
  baseSource: string,
  headSource: string,
  baseSpans: ProvenanceSpan[],
  ctx: CarryContext,
): ProvenanceSpan[] {
  const cfg = ctx.config ?? DEFAULT_CONFIG;
  const base = units(baseSource);
  const head = units(headSource);

  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const ops = diffSequences(base.map((u) => norm(u.text)), head.map((u) => norm(u.text)), (a, b) => a === b);

  const inherited = new Map<number, number>(); // head index -> base index
  const fresh: number[] = [];
  const removedIdx: number[] = [];
  for (const op of ops) {
    if (op.kind === "equal") inherited.set(op.b!, op.a!);
    else if (op.kind === "insert") fresh.push(op.b!);
    else removedIdx.push(op.a!);
  }

  // Pair a new line with the removed line it most plausibly rewrites.
  const rewrites = new Map<number, { baseIndex: number; retained: number }>();
  for (const j of fresh) {
    let best = -1;
    let bestScore = 0.3;
    for (const i of removedIdx) {
      const s = similarity(base[i]!.text, head[j]!.text);
      if (s > bestScore) { bestScore = s; best = i; }
    }
    if (best >= 0) rewrites.set(j, { baseIndex: best, retained: bestScore });
  }

  const ts = ctx.ts ?? new Date().toISOString();
  const spans: ProvenanceSpan[] = head.map((u, j) => {
    const common = {
      start: u.start, end: u.end,
      commit: ctx.commit, author: ctx.author, ts,
      evidence: ctx.evidence ?? [],
    };

    const inheritedIdx = inherited.get(j);
    if (inheritedIdx !== undefined) {
      const prior = spanAt(baseSpans, base[inheritedIdx]!);
      if (prior) {
        return {
          ...common,
          origin: prior.origin,
          session: prior.session,
          declaredModel: prior.declaredModel,
          retained: prior.retained,
          beatId: prior.beatId,
          author: prior.author ?? ctx.author,
          ts: prior.ts ?? ts,
          evidence: prior.evidence ?? [],
          commit: prior.commit ?? ctx.commit,
        };
      }
      return { ...common, origin: "unknown" };
    }

    const rewrite = rewrites.get(j);
    if (rewrite) {
      const prior = spanAt(baseSpans, base[rewrite.baseIndex]!);
      const priorOrigin = prior?.origin ?? "unknown";
      const machineOrigin =
        priorOrigin === "ai_generated" || priorOrigin === "ai_assisted" || priorOrigin === "human_edited_ai";

      if (machineOrigin) {
        if (rewrite.retained >= cfg.retainedHigh) {
          return { ...common, origin: "human_edited_ai", retained: rewrite.retained,
                   session: prior?.session, declaredModel: prior?.declaredModel, beatId: prior?.beatId };
        }
        if (rewrite.retained <= cfg.retainedLow) {
          return { ...common, origin: ctx.newTextOrigin };
        }
        return { ...common, origin: "human_edited_ai", retained: rewrite.retained,
                 session: prior?.session, declaredModel: prior?.declaredModel, beatId: prior?.beatId };
      }
      return { ...common, origin: ctx.newTextOrigin === "unknown" ? priorOrigin : ctx.newTextOrigin };
    }

    return {
      ...common,
      origin: ctx.newTextOrigin,
      session: ctx.session,
      declaredModel: ctx.declaredModel,
    };
  });

  return mergeAdjacent(spans);
}

/** Collapse neighbouring spans that agree on every attribution field. */
export function mergeAdjacent(spans: ProvenanceSpan[]): ProvenanceSpan[] {
  const out: ProvenanceSpan[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    const same =
      last &&
      last.origin === s.origin &&
      last.session === s.session &&
      last.declaredModel === s.declaredModel &&
      last.retained === s.retained &&
      last.beatId === s.beatId &&
      last.commit === s.commit;
    if (same) last.end = s.end;
    else out.push({ ...s });
  }
  return out;
}

/** Commit-level class, derived from spans — never asserted by a client (§7.2). */
export function classifyCommit(changedSpans: ProvenanceSpan[]): ProvenanceClass {
  if (changedSpans.length === 0) return "human";
  const machine = changedSpans.some((s) => s.origin === "ai_generated" || s.origin === "ai_assisted");
  const mixed = changedSpans.some((s) => s.origin === "human_edited_ai");
  const human = changedSpans.some(
    (s) => s.origin === "human_written" || s.origin === "imported" || s.origin === "unknown",
  );
  if (machine && !human && !mixed) return "ai";
  if (machine || mixed) return "hybrid";
  return "human";
}

/** Share of characters attributable to machine origin. Feeds §10's ribbon. */
export function machineShare(spans: ProvenanceSpan[]): number {
  let total = 0;
  let machine = 0;
  for (const s of spans) {
    const len = s.end - s.start;
    total += len;
    if (s.origin === "ai_generated" || s.origin === "ai_assisted") machine += len;
    else if (s.origin === "human_edited_ai") machine += len * (s.retained ?? 0.5);
  }
  return total === 0 ? 0 : machine / total;
}

/** Stable digest over the span set, stamped into the commit trailer (§7.1). */
export function spansDigest(spans: ProvenanceSpan[]): string {
  const canonical = spans.map((s) =>
    [s.start, s.end, s.origin, s.session ?? "", s.retained?.toFixed(4) ?? "", s.beatId ?? ""].join(":"),
  ).join("|");
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** Sidecar serialization: one span per line (§6.4). */
export const toJsonl = (spans: ProvenanceSpan[]): string =>
  spans.map((s) => JSON.stringify(s)).join("\n") + "\n";

export const fromJsonl = (text: string): ProvenanceSpan[] =>
  text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as ProvenanceSpan);
