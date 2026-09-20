import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProvenanceBar } from "./ProvenanceBar";
import { ProseTimeline } from "./ProseTimeline";
import type { Commit } from "@/lib/api";

/**
 * Display components.
 *
 * The risk here is not a broken render, it is a render that quietly overstates
 * what the record proves — collapsing "we did not observe this" into "a human
 * wrote it", or presenting an agent's claim as a verified fact (§3).
 */
describe("ProvenanceBar", () => {
  it("says so plainly when there is nothing recorded", () => {
    render(<ProvenanceBar charsByOrigin={{}} />);
    expect(screen.getByText(/No provenance recorded yet/)).toBeInTheDocument();
  });

  it("shows each origin with its share", () => {
    render(<ProvenanceBar charsByOrigin={{ human_written: 750, ai_generated: 250 }} />);
    expect(screen.getByText(/Written here 75%/)).toBeInTheDocument();
    expect(screen.getByText(/Machine-written 25%/)).toBeInTheDocument();
  });

  it("DOES NOT present imported text as human-written", () => {
    render(<ProvenanceBar charsByOrigin={{ imported: 1000 }} />);
    expect(screen.getByText(/Imported 100%/)).toBeInTheDocument();
    expect(screen.queryByText(/Written here/)).not.toBeInTheDocument();
  });

  it("labels unrecorded text as unrecorded, not as authored", () => {
    render(<ProvenanceBar charsByOrigin={{ unknown: 500, human_written: 500 }} />);
    expect(screen.getByText(/Unrecorded 50%/)).toBeInTheDocument();
  });

  it("distinguishes edited machine text from either pure state", () => {
    render(<ProvenanceBar charsByOrigin={{ human_edited_ai: 400, ai_generated: 300, human_written: 300 }} />);
    expect(screen.getByText(/Edited machine text 40%/)).toBeInTheDocument();
    expect(screen.getByText(/Machine-written 30%/)).toBeInTheDocument();
    expect(screen.getByText(/Written here 30%/)).toBeInTheDocument();
  });

  it("orders segments by share so the dominant origin reads first", () => {
    const { container } = render(
      <ProvenanceBar charsByOrigin={{ human_written: 100, ai_generated: 900 }} />,
    );
    const widths = [...container.querySelectorAll(".prov-seg")].map(
      (el) => (el as HTMLElement).style.width,
    );
    expect(widths[0]).toBe("90%");
  });

  it("does not claim a book is verified or certified", () => {
    render(<ProvenanceBar charsByOrigin={{ human_written: 1000 }} />);
    const text = document.body.textContent?.toLowerCase() ?? "";
    for (const word of ["verified human", "certified", "proven", "guaranteed"]) {
      expect(text, word).not.toContain(word);
    }
  });
});

const commit = (over: Partial<Commit> = {}): Commit => ({
  sha: "a".repeat(40),
  subject: "Draft chapter one",
  message: "Draft chapter one",
  author: "Mara",
  committedAt: "2026-09-20T10:00:00Z",
  provenance: "human",
  ...over,
});

describe("ProseTimeline", () => {
  it("says so when nothing has been committed", () => {
    render(<ProseTimeline commits={[]} />);
    expect(screen.getByText(/Nothing committed yet/)).toBeInTheDocument();
  });

  it("renders commits oldest first, as the book was written", () => {
    const { container } = render(<ProseTimeline commits={[
      commit({ sha: "b".repeat(40), subject: "Second" }),
      commit({ sha: "a".repeat(40), subject: "First" }),
    ]} />);
    const subjects = [...container.querySelectorAll(".tl-subject")].map((el) => el.textContent);
    expect(subjects).toEqual(["First", "Second"]);
  });

  it("bands the history into phases rather than listing raw commits", () => {
    render(<ProseTimeline commits={[
      commit({ subject: "Create Saltmarsh", sha: "c".repeat(40) }),
      commit({ subject: "Add architecture", provenance: "ai", sha: "d".repeat(40) }),
      commit({ subject: "Draft chapter one", sha: "e".repeat(40) }),
    ]} />);
    expect(screen.getByText("Premise")).toBeInTheDocument();
    expect(screen.getByText("Research & architecture")).toBeInTheDocument();
    expect(screen.getByText("Drafting")).toBeInTheDocument();
  });

  it("marks machine and human commits distinctly", () => {
    const { container } = render(<ProseTimeline commits={[
      commit({ provenance: "ai", sha: "f".repeat(40) }),
      commit({ provenance: "human", sha: "0".repeat(40) }),
    ]} />);
    const colours = [...container.querySelectorAll(".tl-dot")].map(
      (el) => (el as HTMLElement).style.background,
    );
    expect(new Set(colours).size).toBe(2);
  });

  it("describes provenance as recorded, not as established fact", () => {
    const { container } = render(<ProseTimeline commits={[commit({ provenance: "ai" })]} />);
    expect(container.querySelector(".tl-dot")?.getAttribute("title")).toBe("Recorded as: ai");
  });

  it("surfaces the receipt so a commit can be verified", () => {
    render(<ProseTimeline commits={[commit({ receipt: "rcpt_01M2Y4CWBK5M6NRVTHHK7KA1SS" })]} />);
    const receipt = screen.getByTitle("rcpt_01M2Y4CWBK5M6NRVTHHK7KA1SS");
    expect(receipt).toBeInTheDocument();
    expect(receipt.textContent).toBe("rcpt…7KA1SS");
  });

  // ULIDs lead with a timestamp, so two receipts from the same day share a
  // long prefix. A leading truncation would render them indistinguishable.
  it("shows enough of a receipt id to tell two apart", () => {
    render(<ProseTimeline commits={[
      commit({ sha: "1".repeat(40), receipt: "rcpt_01M2Y4CWBK5M6NRVTHHK7KA1SS" }),
      commit({ sha: "2".repeat(40), receipt: "rcpt_01M2Y4CWBK5M6NRVTHHK7ZZ9QQ" }),
    ]} />);
    const shown = screen.getAllByTitle(/^rcpt_/).map((el) => el.textContent);
    expect(new Set(shown).size).toBe(2);
  });

  it("copes with an unrecognised provenance value instead of rendering nothing", () => {
    const { container } = render(<ProseTimeline commits={[commit({ provenance: "unknown" })]} />);
    expect(container.querySelector(".tl-dot")).toBeInTheDocument();
    expect(screen.getByText("Draft chapter one")).toBeInTheDocument();
  });
});
