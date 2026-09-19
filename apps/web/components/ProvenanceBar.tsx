/**
 * Whole-book provenance summary (§9.2).
 *
 * `imported` and `unknown` are shown honestly rather than folded into "human" —
 * a manuscript imported from Word on day one is mostly unknown, and implying
 * otherwise would be exactly the over-claim the trust model forbids (§3).
 */
const LABELS: Record<string, { label: string; cls: string }> = {
  ai_generated: { label: "Machine-written", cls: "ai" },
  ai_assisted: { label: "Machine-assisted", cls: "ai" },
  human_edited_ai: { label: "Edited machine text", cls: "hybrid" },
  human_written: { label: "Written here", cls: "human" },
  imported: { label: "Imported", cls: "unknown" },
  unknown: { label: "Unrecorded", cls: "unknown" },
};

export function ProvenanceBar({ charsByOrigin }: { charsByOrigin: Record<string, number> }) {
  const total = Object.values(charsByOrigin).reduce((a, b) => a + b, 0);
  if (total === 0) {
    return <p className="meta">No provenance recorded yet — this book has no text.</p>;
  }
  const entries = Object.entries(charsByOrigin).sort((a, b) => b[1] - a[1]);

  return (
    <div>
      <div className="prov-bar">
        {entries.map(([origin, chars]) => (
          <div
            key={origin}
            className={`prov-seg ${LABELS[origin]?.cls ?? "unknown"}`}
            style={{ width: `${(chars / total) * 100}%`, background: `var(--prov-${LABELS[origin]?.cls ?? "unknown"})` }}
            title={`${LABELS[origin]?.label ?? origin}: ${Math.round((chars / total) * 100)}%`}
          />
        ))}
      </div>
      <div className="prov-legend">
        {entries.map(([origin, chars]) => (
          <span key={origin}>
            <span className={`dot ${LABELS[origin]?.cls ?? "unknown"}`} />
            {LABELS[origin]?.label ?? origin} {Math.round((chars / total) * 100)}%
          </span>
        ))}
      </div>
    </div>
  );
}
