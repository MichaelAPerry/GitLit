"use client";

import type { Derivation, PlanDiff as PlanDiffData } from "@gitlit/diff";
import type { ParsedBeat } from "@gitlit/prose";

/**
 * Mode A — Plan vs. Prose (§9.1).
 *
 * The layout leads with divergence and draws the eye to `unplanned` and
 * `abandoned`, because those are where the author asserted themselves against
 * the plan. A view that highlighted the faithful stretches would be showing
 * the least interesting thing on the page.
 */
const RELATION_COPY: Record<string, { label: string; meaning: string }> = {
  faithful: { label: "followed", meaning: "written close to the beat as planned" },
  developed: { label: "developed", meaning: "the beat, grown by the author" },
  departed: { label: "departed", meaning: "descended from the beat but well away from it" },
  unplanned: { label: "unplanned", meaning: "no beat relates to this — the author's own" },
  abandoned: { label: "unwritten", meaning: "planned, but nothing in the prose realises it" },
};

export interface PlanDiffProps extends PlanDiffData {
  beats: ParsedBeat[];
  paragraphs: { index: number; text: string; wordCount: number }[];
}

export function PlanDiff({ beats, paragraphs, derivations, divergence, counts }: PlanDiffProps) {
  const byParagraph = new Map<number, Derivation>();
  const byBeat = new Map<string, Derivation>();
  for (const d of derivations) {
    if (d.paraIndex !== undefined) byParagraph.set(d.paraIndex, d);
    if (d.beatId && d.paraIndex === undefined) byBeat.set(d.beatId, d);
  }

  return (
    <section>
      <div className="divergence">
        <span className="divergence-figure">{Math.round(divergence.score * 100)}%</span>
        <span className="divergence-label">
          of this chapter left the plan or was never in it
        </span>
      </div>
      <p className="mode-note">
        {divergence.plannedWords.toLocaleString()} words follow the outline;{" "}
        {divergence.departedWords.toLocaleString()} departed from it;{" "}
        {divergence.unplannedWords.toLocaleString()} were never planned.
        {counts.abandoned > 0 && <> {counts.abandoned} beat{counts.abandoned === 1 ? "" : "s"} remain unwritten.</>}
      </p>

      <div className="plan-grid">
        <div className="plan-col">
          <h3>The plan</h3>
          {beats.length === 0 && <p className="meta">No beats were planned for this chapter.</p>}
          {beats.map((beat) => {
            const abandoned = byBeat.get(beat.id);
            const relation = abandoned ? "abandoned" : "faithful";
            return (
              <div key={beat.id} className={`beat r-${abandoned ? "abandoned" : "faithful"}`}>
                <div className="beat-id">
                  {beat.id}
                  {abandoned && (
                    <span className="rel-tag t-abandoned" title={RELATION_COPY.abandoned!.meaning}>
                      {RELATION_COPY.abandoned!.label}
                    </span>
                  )}
                </div>
                <div className="beat-text">{beat.text}</div>
                {beat.sources.length > 0 && (
                  <div className="beat-id">sources: {beat.sources.join(", ")}</div>
                )}
                <span className="sr-only">{relation}</span>
              </div>
            );
          })}
        </div>

        <div className="prose-col">
          <h3>The prose</h3>
          {paragraphs.length === 0 && <p className="meta">This chapter has no prose yet.</p>}
          {paragraphs.map((paragraph) => {
            const d = byParagraph.get(paragraph.index);
            const relation = d?.relation ?? "unplanned";
            const copy = RELATION_COPY[relation]!;
            return (
              <div key={paragraph.index} className={`para r-${relation}`}>
                <div className="beat-id">
                  {d?.beatId ?? "—"}
                  <span className={`rel-tag t-${relation}`} title={copy.meaning}>{copy.label}</span>
                  {d?.method === "declared" && <> · declared by the author</>}
                  {d?.similarity !== undefined && d.beatId && <> · {Math.round(d.similarity * 100)}% of the beat survives</>}
                </div>
                <div className="para-text">{paragraph.text}</div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
