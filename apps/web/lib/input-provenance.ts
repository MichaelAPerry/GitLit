"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Input provenance capture for GitLit Write (§7.5).
 *
 * Design rule: RECORD, DO NOT ACCUSE. Every insertion carries a neutral,
 * observed input mode. Paste is not evidence of AI — authors paste their own
 * notes and earlier drafts constantly — and dictation, IME composition and
 * swipe keyboards are accessibility and language-support needs, never flags.
 *
 * Only aggregates and non-typed events leave the browser. We never build,
 * transmit or store a keylog: that would be a surveillance product and a
 * breach liability, and it buys nothing the aggregates do not.
 */

export type InputMode =
  | "typed" | "pasted" | "dictated" | "composed" | "dropped" | "imported" | "synthetic";

/** Named to avoid shadowing the DOM `InputEvent`, which this module reads. */
export interface InputEventRecord {
  inputMode: Exclude<InputMode, "typed">;
  charCount: number;
  wordCount: number;
  /** Hash of the inserted text. The text itself is never stored (§7.5.5). */
  contentHash: string;
  isTrusted: boolean;
  occurredAt: string;
}

export interface SessionAggregates {
  keystrokes: number;
  modeWords: Record<string, number>;
  medianWpm: number | null;
  burstCount: number;
  /** Inter-keystroke interval histogram, 8 log-spaced buckets. */
  ikiHistogram: number[];
}

/** Events below this are ordinary editing and produce no row (§7.5.5). */
const EVENT_THRESHOLD = 200;
const BUCKETS = [50, 100, 200, 400, 800, 1600, 3200, Infinity];

async function sha256(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) return `len:${text.length}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const countWords = (t: string) => (t.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

export function useInputProvenance() {
  const [events, setEvents] = useState<InputEventRecord[]>([]);
  const [aggregates, setAggregates] = useState<SessionAggregates>({
    keystrokes: 0, modeWords: {}, medianWpm: null, burstCount: 0,
    ikiHistogram: new Array(BUCKETS.length).fill(0),
  });

  const lastKey = useRef<number | null>(null);
  const intervals = useRef<number[]>([]);
  const composing = useRef(false);
  const element = useRef<HTMLTextAreaElement | null>(null);
  const nativeListener = useRef<((event: Event) => void) | null>(null);

  const record = useCallback(async (mode: Exclude<InputMode, "typed">, text: string, isTrusted: boolean) => {
    const words = countWords(text);
    setAggregates((a) => ({ ...a, modeWords: { ...a.modeWords, [mode]: (a.modeWords[mode] ?? 0) + words } }));
    if (text.length < EVENT_THRESHOLD) return;

    /**
     * Hash before recording, not after.
     *
     * An earlier version inserted the event with a "pending" placeholder and
     * back-filled it once the digest resolved — but the back-fill matched on
     * the placeholder, so with two insertions in flight the second digest
     * landed on the first event. A content hash that does not match its
     * content is worse than none: it is evidence that is wrong.
     */
    const contentHash = await sha256(text);
    setEvents((prev) => [...prev, {
      inputMode: mode, charCount: text.length, wordCount: words,
      contentHash, isTrusted, occurredAt: new Date().toISOString(),
    }]);
  }, []);

  const onKeyDown = useCallback(() => {
    const now = performance.now();
    if (lastKey.current !== null) {
      const delta = now - lastKey.current;
      if (delta < 5000) intervals.current.push(delta);
    }
    lastKey.current = now;
    setAggregates((a) => ({ ...a, keystrokes: a.keystrokes + 1 }));
  }, []);

  const onPaste = useCallback((e: React.ClipboardEvent) => {
    void record("pasted", e.clipboardData.getData("text/plain"), e.nativeEvent.isTrusted);
  }, [record]);

  const onDrop = useCallback((e: React.DragEvent) => {
    void record("dropped", e.dataTransfer.getData("text/plain"), e.nativeEvent.isTrusted);
  }, [record]);

  const onCompositionStart = useCallback(() => { composing.current = true; }, []);
  const onCompositionEnd = useCallback((e: React.CompositionEvent) => {
    composing.current = false;
    void record("composed", e.data ?? "", e.nativeEvent.isTrusted);
  }, [record]);

  /**
   * `beforeinput` names the origin of insertions that never touched a key —
   * speech-to-text, autofill, script-driven insertion.
   *
   * This must be a NATIVE listener. React's `onBeforeInput` is a synthetic
   * polyfill built from composition and keypress events and does not carry
   * `inputType`, so reading it there silently misses dictation and then
   * misfiles it as script-driven input — exactly the accessibility
   * misclassification this module exists to avoid.
   */
  const attachTo = useCallback((el: HTMLTextAreaElement | null) => {
    if (element.current === el) return;

    if (element.current && nativeListener.current) {
      element.current.removeEventListener("beforeinput", nativeListener.current);
    }
    element.current = el;
    if (!el) { nativeListener.current = null; return; }

    const listener = (event: Event) => {
      const input = event as InputEvent;
      const data = input.data ?? "";
      if (!data) return;

      if (input.inputType === "insertReplacementText" && !composing.current) {
        void record("dictated", data, input.isTrusted);
        return;
      }
      if (input.inputType === "insertFromPaste" || input.inputType === "insertFromDrop") {
        return; // already recorded by the paste/drop handlers
      }
      if (!input.isTrusted) void record("synthetic", data, false);
    };

    nativeListener.current = listener;
    el.addEventListener("beforeinput", listener);
  }, [record]);

  useEffect(() => {
    const id = setInterval(() => {
      const xs = intervals.current;
      if (xs.length < 5) return;
      const sorted = [...xs].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)]!;
      const histogram = new Array(BUCKETS.length).fill(0);
      for (const v of xs) histogram[BUCKETS.findIndex((b) => v < b)]!++;
      setAggregates((a) => ({
        ...a,
        medianWpm: median > 0 ? Math.round(60_000 / (median * 5)) : null,
        burstCount: xs.filter((v) => v > 2000).length + 1,
        ikiHistogram: histogram,
      }));
    }, 3000);
    return () => clearInterval(id);
  }, []);

  return {
    events,
    aggregates,
    /** Spread onto the editor element. `ref` installs the native listener. */
    handlers: {
      ref: attachTo,
      onKeyDown,
      onPaste,
      onDrop,
      onCompositionStart,
      onCompositionEnd,
    },
  };
}
