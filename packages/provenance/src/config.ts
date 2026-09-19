/**
 * Retention thresholds (§7.3). Versioned and recorded per commit so that a
 * later change never silently rewrites what past history means.
 */
export interface ProvenanceConfig {
  version: string;
  /** At or above this, an edited AI sentence stays attributed as AI-derived. */
  retainedHigh: number;
  /** At or below this, the sentence is the author's own writing. */
  retainedLow: number;
}

export const DEFAULT_CONFIG: ProvenanceConfig = {
  version: "spans/v1",
  retainedHigh: 0.85,
  retainedLow: 0.35,
};
