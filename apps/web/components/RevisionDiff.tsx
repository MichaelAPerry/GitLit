"use client";

import type { ProseDiff } from "@gitlit/diff";

/**
 * Mode C — classic revision diff (§9.3).
 *
 * Sentence-level, with word-level detail inside a changed sentence and moved
 * sentences reported as moves. Restructuring is most of revision in prose, and
 * a naive diff renders a moved scene as a total rewrite, which tells an author
 * nothing about what they actually changed.
 */
export function RevisionDiff({ diff }: { diff: ProseDiff }) {
  const { changes, stats } = diff;

  if (changes.every((c) => c.kind === "equal")) {
    return <p className="meta">No prose changed between these two commits.</p>;
  }

  return (
    <section>
      <p className="mode-note">
        {stats.added} added · {stats.modified} revised · {stats.removed} cut ·{" "}
        {stats.moved} moved · {stats.unchanged} unchanged
      </p>

      <div className="revision">
        {changes.map((change, i) => {
          if (change.kind === "equal") {
            return <div key={i} className="rev-line rev-equal">{change.headText}</div>;
          }
          if (change.kind === "modified" && change.words) {
            return (
              <div key={i} className="rev-line rev-modified">
                {change.words.map((run, j) => (
                  <span key={j} className={run.kind === "equal" ? "" : `w-${run.kind}`}>
                    {run.text}
                  </span>
                ))}
              </div>
            );
          }
          const text = change.headText ?? change.baseText ?? "";
          return (
            <div key={i} className={`rev-line rev-${change.kind}`}>
              {change.kind === "moved" && <span className="beat-id">moved · </span>}
              {text}
            </div>
          );
        })}
      </div>
    </section>
  );
}
