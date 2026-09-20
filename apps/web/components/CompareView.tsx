"use client";

import { useCallback, useEffect, useState } from "react";
import type { ProseDiff } from "@gitlit/diff";
import type { ProvenanceSpan } from "@gitlit/core";
import { api } from "@/lib/api";
import { PlanDiff, type PlanDiffProps } from "./PlanDiff";
import { HeatView } from "./HeatView";
import { RevisionDiff } from "./RevisionDiff";

type Mode = "plan" | "heat" | "revision";

const MODES: { id: Mode; label: string; note: string }[] = [
  {
    id: "plan",
    label: "Plan vs. prose",
    note: "What the machine planned, beside what the author wrote. The interesting parts are " +
          "where they disagree.",
  },
  {
    id: "heat",
    label: "Who wrote what",
    note: "The chapter as continuous prose, marked by what GitLit observed about each stretch. " +
          "Evidence of how the text arrived, not proof of who composed it.",
  },
  {
    id: "revision",
    label: "Revisions",
    note: "Commit to commit, sentence by sentence. Moved sentences are shown as moves rather " +
          "than as a rewrite.",
  },
];

export function CompareView({
  owner, slug, path, initialMode,
}: { owner: string; slug: string; path: string; initialMode: string }) {
  const [mode, setMode] = useState<Mode>(
    MODES.some((m) => m.id === initialMode) ? (initialMode as Mode) : "plan",
  );
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const base = `/v1/repositories/${owner}/${slug}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (mode === "plan") {
        setData(await api(`${base}/diff/plan?path=${encodeURIComponent(path)}`));
      } else if (mode === "heat") {
        setData(await api(`${base}/provenance/${path}`));
      } else {
        const { commits } = await api<{ commits: { sha: string }[] }>(`${base}/commits`);
        if (commits.length < 2) { setData({ notEnough: true }); return; }
        const [head, previous] = [commits[0]!.sha, commits[1]!.sha];
        setData(await api(
          `${base}/diff?base=${previous}&head=${head}&path=${encodeURIComponent(path)}`,
        ));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this view.");
    } finally {
      setLoading(false);
    }
  }, [base, mode, path]);

  useEffect(() => { void load(); }, [load]);

  const active = MODES.find((m) => m.id === mode)!;

  return (
    <div>
      <div className="modes" role="tablist" aria-label="Comparison mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={m.id === mode}
            className="mode-tab"
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="mode-note">{active.note}</p>

      {loading && <p className="meta">Reading the history…</p>}
      {error && <p style={{ color: "#b4462f" }}>{error}</p>}

      {!loading && !error && data !== null && (
        <>
          {mode === "plan" && renderPlan(data)}
          {mode === "heat" && renderHeat(data)}
          {mode === "revision" && renderRevision(data)}
        </>
      )}
    </div>
  );
}

function renderPlan(data: unknown) {
  const d = data as PlanDiffProps & { hasPlan: boolean; note?: string; caveat?: string };
  if (!d.hasPlan) {
    return (
      <div className="notice">
        <strong>No plan to compare against.</strong> {d.note}
      </div>
    );
  }
  return (
    <>
      <PlanDiff {...d} />
      {d.caveat && <div className="notice" style={{ marginTop: 20 }}>{d.caveat}</div>}
    </>
  );
}

function renderHeat(data: unknown) {
  const d = data as { content: string; spans: ProvenanceSpan[]; caveat?: string };
  return (
    <>
      <HeatView content={d.content} spans={d.spans} />
      {d.caveat && <div className="notice" style={{ marginTop: 20 }}>{d.caveat}</div>}
    </>
  );
}

function renderRevision(data: unknown) {
  const d = data as ProseDiff & { notEnough?: boolean };
  if (d.notEnough) {
    return <p className="meta">This chapter has only one commit, so there is nothing to compare it with.</p>;
  }
  return <RevisionDiff diff={d} />;
}
