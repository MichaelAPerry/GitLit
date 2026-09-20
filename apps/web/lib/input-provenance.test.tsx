import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useInputProvenance } from "./input-provenance";

/**
 * Input provenance capture (§7.5).
 *
 * The assertions that matter most here are negative ones: that no keystroke
 * content is retained, and that accessibility input modes are never treated as
 * suspicious. Both are guarantees a refactor could break silently while every
 * visible behaviour still looked right.
 */
function Harness() {
  const { events, aggregates, handlers } = useInputProvenance();
  return (
    <div>
      <textarea
        data-testid="editor"
        ref={handlers.ref}
        onKeyDown={handlers.onKeyDown}
        onPaste={handlers.onPaste}
        onDrop={handlers.onDrop}
        onCompositionStart={handlers.onCompositionStart}
        onCompositionEnd={handlers.onCompositionEnd}
      />
      <output data-testid="events">{JSON.stringify(events)}</output>
      <output data-testid="aggregates">{JSON.stringify(aggregates)}</output>
    </div>
  );
}

const setup = () => {
  render(<Harness />);
  return {
    editor: screen.getByTestId("editor"),
    events: () => JSON.parse(screen.getByTestId("events").textContent || "[]"),
    aggregates: () => JSON.parse(screen.getByTestId("aggregates").textContent || "{}"),
  };
};

const LONG = "The lighthouse had been dark for eleven years. ".repeat(12); // > 200 chars
const SHORT = "A short phrase.";

/** jsdom's clipboard events need the data constructed by hand. */
function paste(el: Element, text: string) {
  const event = new Event("paste", { bubbles: true }) as Event & { clipboardData: unknown };
  event.clipboardData = { getData: () => text };
  fireEvent(el, event);
}

/**
 * Recording is async — the digest is computed before the event is stored — so
 * the queue has to drain before the record is observable.
 */
async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function drop(el: Element, text: string) {
  const event = new Event("drop", { bubbles: true }) as Event & { dataTransfer: unknown };
  event.dataTransfer = { getData: () => text };
  fireEvent(el, event);
}

describe("paste", () => {
  it("records a large paste as an event", async () => {
    const { editor, events } = setup();
    await act(async () => { paste(editor, LONG); });
    await flush();
    expect(events()).toHaveLength(1);
    expect(events()[0].inputMode).toBe("pasted");
  });

  it("counts a small paste in the aggregates but creates no event row", async () => {
    const { editor, events, aggregates } = setup();
    await act(async () => { paste(editor, SHORT); });
    await flush();
    expect(events()).toHaveLength(0);
    expect(aggregates().modeWords.pasted).toBe(3);
  });

  it("STORES A HASH, NEVER THE TEXT", async () => {
    const { editor, events } = setup();
    const secret = "Mara counted the winters on the drive up to the headland. ".repeat(6);
    await act(async () => { paste(editor, secret); });
    await flush();

    const recorded = JSON.stringify(events());
    expect(recorded).not.toContain("Mara");
    expect(recorded).not.toContain("headland");
    expect(events()[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records size and word count so the author can see what was noted", async () => {
    const { editor, events } = setup();
    await act(async () => { paste(editor, LONG); });
    await flush();
    expect(events()[0].charCount).toBe(LONG.length);
    expect(events()[0].wordCount).toBeGreaterThan(50);
  });

  it("hashes different pastes differently and identical pastes the same", async () => {
    const { editor, events } = setup();
    await act(async () => { paste(editor, LONG); });
    await flush();
    await act(async () => { paste(editor, LONG.replace("lighthouse", "beacon")); });
    await act(async () => { paste(editor, LONG); });
    await flush();
    const hashes = events().map((e: { contentHash: string }) => e.contentHash);
    expect(hashes[0]).toBe(hashes[2]);
    expect(hashes[0]).not.toBe(hashes[1]);
  });
});

describe("other input modes", () => {
  it("records a drop as 'dropped', not as a paste", async () => {
    const { editor, events } = setup();
    await act(async () => { drop(editor, LONG); });
    await flush();
    expect(events()[0].inputMode).toBe("dropped");
  });

  it("records IME composition as 'composed'", async () => {
    const { editor, aggregates } = setup();
    await act(async () => {
      fireEvent.compositionStart(editor);
      fireEvent.compositionEnd(editor, { data: "こんにちは世界" });
    });
    expect(aggregates().modeWords.composed).toBeGreaterThan(0);
  });

  it("records speech-to-text as 'dictated'", async () => {
    const { editor, aggregates } = setup();
    await act(async () => {
      fireEvent(editor, Object.assign(
        new Event("beforeinput", { bubbles: true }),
        { data: "she walked the rest of the way", inputType: "insertReplacementText" },
      ));
    });
    expect(aggregates().modeWords.dictated).toBe(7);
  });

  it("NEVER FLAGS accessibility input as suspicious", async () => {
    const { editor, aggregates, events } = setup();
    await act(async () => {
      fireEvent.compositionStart(editor);
      fireEvent.compositionEnd(editor, { data: "日本語入力" });
      fireEvent(editor, Object.assign(
        new Event("beforeinput", { bubbles: true }),
        { data: "dictated words here", inputType: "insertReplacementText" },
      ));
    });
    const modes = [
      ...Object.keys(aggregates().modeWords),
      ...events().map((e: { inputMode: string }) => e.inputMode),
    ];
    expect(modes).not.toContain("synthetic");
    expect(modes.every((m) => ["composed", "dictated"].includes(m))).toBe(true);
  });
});

describe("keystrokes", () => {
  it("counts keystrokes", async () => {
    const { editor, aggregates } = setup();
    await act(async () => {
      for (const key of "hello") fireEvent.keyDown(editor, { key });
    });
    expect(aggregates().keystrokes).toBe(5);
  });

  it("KEEPS NO KEYLOG — the typed characters appear nowhere", async () => {
    const { editor, aggregates, events } = setup();
    await act(async () => {
      for (const key of "SECRETMANUSCRIPT") fireEvent.keyDown(editor, { key });
    });
    const everything = JSON.stringify(aggregates()) + JSON.stringify(events());
    expect(everything).not.toMatch(/SECRET/i);
    expect(everything).not.toMatch(/[A-Z]{4,}/);
    expect(aggregates().keystrokes).toBe(16);
  });

  it("does not create input events for typing", async () => {
    const { editor, events } = setup();
    await act(async () => {
      for (let i = 0; i < 300; i++) fireEvent.keyDown(editor, { key: "a" });
    });
    expect(events()).toHaveLength(0);
  });

  it("starts with an empty histogram rather than fabricated cadence", () => {
    const { aggregates } = setup();
    expect(aggregates().medianWpm).toBeNull();
    expect(aggregates().ikiHistogram.every((n: number) => n === 0)).toBe(true);
  });
});

describe("untrusted input", () => {
  it("marks script-driven insertion as synthetic", async () => {
    const { editor, aggregates } = setup();
    // jsdom dispatches with isTrusted false, which is exactly the signal.
    await act(async () => {
      fireEvent(editor, Object.assign(
        new Event("beforeinput", { bubbles: true }),
        { data: "injected by a script", inputType: "insertText" },
      ));
    });
    expect(aggregates().modeWords.synthetic).toBe(4);
  });

  it("records trust on the event so the server can weigh it", async () => {
    const { editor, events } = setup();
    await act(async () => { paste(editor, LONG); });
    await flush();
    expect(events()[0]).toHaveProperty("isTrusted");
  });
});

describe("resilience", () => {
  it("ignores an empty paste", async () => {
    const { editor, events, aggregates } = setup();
    await act(async () => { paste(editor, ""); });
    await flush();
    expect(events()).toHaveLength(0);
    expect(aggregates().modeWords.pasted ?? 0).toBe(0);
  });

  it("survives crypto.subtle being unavailable", async () => {
    // Private-browsing and insecure-origin contexts have no subtle crypto;
    // the capture must degrade rather than throw inside an author's editor.
    const subtle = globalThis.crypto.subtle;
    Object.defineProperty(globalThis.crypto, "subtle", { value: undefined, configurable: true });
    try {
      const { editor, events } = setup();
      await act(async () => { paste(editor, LONG); });
    await flush();
      expect(events()).toHaveLength(1);
      expect(events()[0].contentHash).toMatch(/^len:/);
    } finally {
      Object.defineProperty(globalThis.crypto, "subtle", { value: subtle, configurable: true });
    }
  });
});

describe("concurrent insertions", () => {
  // Regression: events were inserted with a placeholder digest and back-filled
  // by matching on it, so two insertions in flight swapped hashes.
  it("gives every event its OWN hash when several arrive together", async () => {
    const { editor, events } = setup();
    const a = "Alpha sentence about the lighthouse keeper. ".repeat(6);
    const b = "Beta sentence about the empty cottage. ".repeat(6);

    await act(async () => {
      paste(editor, a);
      paste(editor, b);
      paste(editor, a);
    });
    await flush();

    const recorded = events();
    expect(recorded).toHaveLength(3);
    expect(recorded[0].contentHash).toBe(recorded[2].contentHash);
    expect(recorded[0].contentHash).not.toBe(recorded[1].contentHash);
    expect(recorded.every((e: { contentHash: string }) => /^[0-9a-f]{64}$/.test(e.contentHash))).toBe(true);
  });

  it("never leaves a placeholder in the record", async () => {
    const { editor, events } = setup();
    await act(async () => { paste(editor, LONG); paste(editor, LONG + "x"); });
    await flush();
    expect(JSON.stringify(events())).not.toContain("pending");
  });
});
