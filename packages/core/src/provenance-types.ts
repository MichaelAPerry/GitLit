import { z } from "zod";

/** Commit-level origin (§7.2). Computed from spans, never client-asserted. */
export const ProvenanceClass = z.enum(["ai", "hybrid", "human"]);
export type ProvenanceClass = z.infer<typeof ProvenanceClass>;

/** Span-level origin (§6.4). `imported` and `unknown` are honest states. */
export const SpanOrigin = z.enum([
  "ai_generated",
  "ai_assisted",
  "human_edited_ai",
  "human_written",
  "imported",
  "unknown",
]);
export type SpanOrigin = z.infer<typeof SpanOrigin>;

/**
 * How text entered the document (§7.5.3). Recorded as neutral fact.
 * `dictated` and `composed` are accessibility/language-support modes and are
 * never treated as suspicious.
 */
export const InputMode = z.enum([
  "typed",
  "pasted",
  "dictated",
  "composed",
  "dropped",
  "imported",
  "ai_tool",
  "synthetic",
]);
export type InputMode = z.infer<typeof InputMode>;

export const ProvenanceSpan = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  origin: SpanOrigin,
  commit: z.string().optional(),
  author: z.string().optional(),
  session: z.string().optional(),
  declaredModel: z.string().optional(),
  retained: z.number().min(0).max(1).optional(),
  beatId: z.string().optional(),
  evidence: z.array(z.string()).default([]),
  ts: z.string().optional(),
});
export type ProvenanceSpan = z.infer<typeof ProvenanceSpan>;

export const DocumentStatus = z.enum(["planned", "drafting", "drafted", "revised", "final"]);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

export const RepoPhase = z.enum([
  "premise", "novelty", "research", "architecture", "drafting", "revision", "final",
]);
export type RepoPhase = z.infer<typeof RepoPhase>;

export const DerivationRelation = z.enum([
  "faithful", "developed", "departed", "unplanned", "abandoned",
]);
export type DerivationRelation = z.infer<typeof DerivationRelation>;
