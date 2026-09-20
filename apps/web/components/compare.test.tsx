import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PlanDiff } from "./PlanDiff";
import { HeatView } from "./HeatView";
import { RevisionDiff } from "./RevisionDiff";
import type { ParsedBeat } from "@gitlit/prose";
import type { Derivation } from "@gitlit/diff";

const beat = (id: string, text: string): ParsedBeat => ({ id, text, sources: [], chapterId: "ch1" });
const para = (index: number, text: string, wordCount: number) => ({ index, text, wordCount });

const planProps = (over: Partial<Parameters<typeof PlanDiff>[0]> = {}) => ({
  beats: [beat("b1.1", "Mara drives the headland road"), beat("b1.2", "The cottage is unchanged")],
  paragraphs: [para(0, "Mara drove the headland road.", 5), para(1, "Her mother's hands shook.", 4)],
  derivations: [
    { beatId: "b1.1", paraIndex: 0, relation: "faithful", similarity: 0.91, method: "lexical" },
    { paraIndex: 1, relation: "unplanned", similarity: 0.05, method: "lexical" },
    { beatId: "b1.2", relation: "abandoned", similarity: 0, method: "lexical" },
  ] as Derivation[],
  divergence: { score: 0.44, departedWords: 0, unplannedWords: 4, plannedWords: 5, totalWords: 9 },
  counts: { faithful: 1, developed: 0, departed: 0, unplanned: 1, abandoned: 1 },
  algoVersion: "derivation/lexical-v1",
  ...over,
});

describe("PlanDiff (Mode A)", () => {
  it("leads with the divergence figure", () => {
    render(<PlanDiff {...planProps()} />);
    expect(screen.getByText("44%")).toBeInTheDocument();
    expect(screen.getByText(/left the plan or was never in it/)).toBeInTheDocument();
  });

  it("shows both the plan and the prose", () => {
    render(<PlanDiff {...planProps()} />);
    expect(screen.getByText("Mara drives the headland road")).toBeInTheDocument();
    expect(screen.getByText("Mara drove the headland road.")).toBeInTheDocument();
  });

  it("CALLS UNPLANNED PROSE THE AUTHOR'S OWN, not an anomaly", () => {
    render(<PlanDiff {...planProps()} />);
    const tag = screen.getByTitle(/no beat relates to this — the author's own/);
    expect(tag).toHaveTextContent("unplanned");
  });

  it("marks a beat nothing realised as unwritten rather than failed", () => {
    render(<PlanDiff {...planProps()} />);
    expect(screen.getByTitle(/planned, but nothing in the prose realises it/)).toHaveTextContent("unwritten");
  });

  it("says when the author declared the link themselves", () => {
    render(<PlanDiff {...planProps({
      derivations: [{ beatId: "b1.1", paraIndex: 0, relation: "developed", similarity: 0.6, method: "declared" }],
    })} />);
    expect(screen.getByText(/declared by the author/)).toBeInTheDocument();
  });

  it("reports the word split behind the figure", () => {
    render(<PlanDiff {...planProps()} />);
    expect(screen.getByText(/5 words follow the outline/)).toBeInTheDocument();
    expect(screen.getByText(/4 were never planned/)).toBeInTheDocument();
  });

  it("copes with a chapter that has no plan and no prose", () => {
    render(<PlanDiff {...planProps({
      beats: [], paragraphs: [], derivations: [],
      divergence: { score: 0, departedWords: 0, unplannedWords: 0, plannedWords: 0, totalWords: 0 },
      counts: { faithful: 0, developed: 0, departed: 0, unplanned: 0, abandoned: 0 },
    })} />);
    expect(screen.getByText(/No beats were planned/)).toBeInTheDocument();
    expect(screen.getByText(/no prose yet/)).toBeInTheDocument();
  });
});

const spans = [
  { start: 0, end: 20, origin: "ai_generated", evidence: [], declaredModel: "claude-opus-5" },
  { start: 20, end: 42, origin: "human_written", evidence: [] },
];

describe("HeatView (Mode B)", () => {
  const content = "Machine wrote this. The author wrote this";

  it("renders the prose continuously, not as a list", () => {
    render(<HeatView content={content} spans={spans as never} />);
    expect(screen.getByText(/Machine wrote this/)).toBeInTheDocument();
  });

  it("describes the declared model as a claim", () => {
    render(<HeatView content={content} spans={spans as never} />);
    expect(screen.getByTitle(/model claimed: claude-opus-5/)).toBeInTheDocument();
  });

  it("describes unknown origin as no record, not as human authorship", () => {
    render(<HeatView content="Imported text here." spans={[
      { start: 0, end: 19, origin: "unknown", evidence: [] },
    ] as never} />);
    expect(screen.getByTitle(/arrived without a record of how it was written/)).toBeInTheDocument();
  });

  it("offers the machine-only filter", () => {
    render(<HeatView content={content} spans={spans as never} />);
    expect(screen.getByRole("button", { name: /only machine-originated/ })).toBeInTheDocument();
  });

  it("says so when there is nothing recorded", () => {
    render(<HeatView content="x" spans={[]} />);
    expect(screen.getByText(/No provenance recorded/)).toBeInTheDocument();
  });
});

describe("RevisionDiff (Mode C)", () => {
  it("summarises what changed", () => {
    render(<RevisionDiff diff={{
      changes: [{ kind: "added", headIndex: 0, headText: "A new sentence." }],
      stats: { added: 1, removed: 0, modified: 0, moved: 0, unchanged: 3 },
    }} />);
    expect(screen.getByText(/1 added/)).toBeInTheDocument();
    expect(screen.getByText(/3 unchanged/)).toBeInTheDocument();
  });

  it("shows word-level detail inside a revised sentence", () => {
    const { container } = render(<RevisionDiff diff={{
      changes: [{
        kind: "modified", baseIndex: 0, headIndex: 0,
        baseText: "dark for eleven years", headText: "dark for twelve years",
        words: [
          { kind: "equal", text: "dark for " },
          { kind: "removed", text: "eleven" },
          { kind: "added", text: "twelve" },
          { kind: "equal", text: " years" },
        ],
      }],
      stats: { added: 0, removed: 0, modified: 1, moved: 0, unchanged: 0 },
    }} />);
    expect(container.querySelector(".w-removed")).toHaveTextContent("eleven");
    expect(container.querySelector(".w-added")).toHaveTextContent("twelve");
  });

  it("LABELS A MOVE AS A MOVE, not as a rewrite", () => {
    const { container } = render(<RevisionDiff diff={{
      changes: [{ kind: "moved", headIndex: 0, headText: "Relocated sentence.", similarity: 1 }],
      stats: { added: 0, removed: 0, modified: 0, moved: 1, unchanged: 0 },
    }} />);
    const line = container.querySelector(".rev-moved");
    expect(line).toHaveTextContent("moved");
    expect(line).toHaveTextContent("Relocated sentence.");
    // A move must not be rendered as an addition plus a deletion.
    expect(container.querySelector(".rev-added")).toBeNull();
    expect(container.querySelector(".rev-removed")).toBeNull();
  });

  it("says plainly when nothing changed", () => {
    render(<RevisionDiff diff={{
      changes: [{ kind: "equal", baseIndex: 0, headIndex: 0, headText: "Same." }],
      stats: { added: 0, removed: 0, modified: 0, moved: 0, unchanged: 1 },
    }} />);
    expect(screen.getByText(/No prose changed/)).toBeInTheDocument();
  });
});

describe("language across all three modes", () => {
  it("never claims the record proves who wrote something", () => {
    render(<><PlanDiff {...planProps()} /><HeatView content="x y" spans={spans as never} /></>);
    const text = (document.body.textContent ?? "").toLowerCase();
    for (const word of ["proves", "certified", "verified human", "guaranteed", "plagiar"]) {
      expect(text, word).not.toContain(word);
    }
  });
});
