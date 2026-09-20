import type { Commit } from "@/lib/api";

/**
 * Prose Timeline (§10) — a phase-banded spine, not a commit list.
 *
 * Phases are derived from commit trailers rather than set by hand, so the
 * shape of the book's life is a consequence of what actually happened.
 */
const PROV_CLASS: Record<string, string> = {
  ai: "var(--prov-ai)",
  hybrid: "var(--prov-hybrid)",
  human: "var(--prov-human)",
};

/**
 * ULIDs are timestamp-prefixed, so a leading truncation renders every receipt
 * issued on the same day identically — unlike a git short sha, where the
 * entropy is spread throughout. Show the random tail instead, which is the
 * part that actually distinguishes one receipt from another.
 */
function shortReceipt(id: string): string {
  const [prefix, ulid] = id.split("_");
  if (!ulid) return id.slice(-8);
  return `${prefix}…${ulid.slice(-6)}`;
}

function phaseOf(c: Commit): string {
  if (c.provenance === "ai") return "Research & architecture";
  if (c.subject.toLowerCase().startsWith("create ")) return "Premise";
  if (c.provenance === "hybrid") return "Revision";
  return "Drafting";
}

export function ProseTimeline({ commits }: { commits: Commit[] }) {
  if (commits.length === 0) {
    return <p className="meta">Nothing committed yet.</p>;
  }

  const ordered = [...commits].reverse();
  let lastPhase = "";

  return (
    <div className="timeline">
      {ordered.map((c) => {
        const phase = phaseOf(c);
        const showBand = phase !== lastPhase;
        lastPhase = phase;
        return (
          <div key={c.sha}>
            {showBand && <div className="phase-band">{phase}</div>}
            <div className="tl-item">
              <span
                className="tl-dot"
                style={{ background: PROV_CLASS[c.provenance] ?? "var(--prov-unknown)" }}
                title={`Recorded as: ${c.provenance}`}
              />
              <div className="tl-subject">{c.subject}</div>
              <div className="tl-meta">
                {new Date(c.committedAt).toLocaleString()} · {c.author} ·{" "}
                <code>{c.sha.slice(0, 7)}</code>
                {c.receipt && <> · receipt <code title={c.receipt}>{shortReceipt(c.receipt)}</code></>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
