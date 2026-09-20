"use client";

import { useState } from "react";
import type { ProvenanceSpan } from "@gitlit/core";

/**
 * Mode B — provenance heat (§9.2).
 *
 * The chapter as continuous prose, each stretch underlined by what GitLit
 * observed about it. `imported` and `unknown` are drawn with a dotted rule
 * rather than folded into "written here" — a manuscript brought in from
 * elsewhere is mostly unknown, and implying otherwise would be the exact
 * over-claim the trust model forbids (§3).
 */
const ORIGIN_COPY: Record<string, string> = {
  ai_generated: "machine-written",
  ai_assisted: "machine-assisted",
  human_edited_ai: "machine text the author edited",
  human_written: "written in GitLit",
  imported: "imported from elsewhere",
  unknown: "arrived without a record of how it was written",
};

export function HeatView({ content, spans }: { content: string; spans: ProvenanceSpan[] }) {
  const [machineOnly, setMachineOnly] = useState(false);

  const ordered = [...spans].sort((a, b) => a.start - b.start);
  const pieces: { text: string; span?: ProvenanceSpan }[] = [];
  let cursor = 0;
  for (const span of ordered) {
    if (span.start > cursor) pieces.push({ text: content.slice(cursor, span.start) });
    pieces.push({ text: content.slice(span.start, span.end), span });
    cursor = span.end;
  }
  if (cursor < content.length) pieces.push({ text: content.slice(cursor) });

  const isMachine = (o?: string) =>
    o === "ai_generated" || o === "ai_assisted" || o === "human_edited_ai";

  if (spans.length === 0) {
    return <p className="meta">No provenance recorded for this file yet.</p>;
  }

  return (
    <section>
      <p className="mode-note">
        <button className="btn secondary" onClick={() => setMachineOnly((v) => !v)}>
          {machineOnly ? "Show the whole chapter" : "Show only machine-originated text"}
        </button>
      </p>

      <div className="heat">
        {pieces.map((piece, i) => {
          const origin = piece.span?.origin;
          if (machineOnly && !isMachine(origin)) {
            return <span key={i} style={{ opacity: 0.18 }}>{piece.text}</span>;
          }
          if (!origin) return <span key={i}>{piece.text}</span>;
          const detail = [
            ORIGIN_COPY[origin] ?? origin,
            piece.span?.declaredModel && `model claimed: ${piece.span.declaredModel}`,
            piece.span?.retained !== undefined && `${Math.round(piece.span.retained * 100)}% retained`,
            piece.span?.commit && `commit ${piece.span.commit.slice(0, 7)}`,
          ].filter(Boolean).join(" · ");
          return (
            <span key={i} className={`heat-span o-${origin}`} title={detail}>
              {piece.text}
            </span>
          );
        })}
      </div>
    </section>
  );
}
