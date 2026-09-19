"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { API } from "@/lib/api";
import { useInputProvenance } from "@/lib/input-provenance";

/**
 * GitLit Write (§7.5) — the default authoring surface.
 *
 * One column, no chrome, the book and nothing else. The instrumentation is
 * deliberately unobtrusive: this has to be pleasant to write in first, or the
 * provenance it captures is worth nothing because nobody uses it.
 */
export function Composer({
  owner, slug, path, initialContent,
}: {
  owner: string; slug: string; path: string; initialContent: string;
}) {
  const [text, setText] = useState(initialContent);
  const [saved, setSaved] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [showRecord, setShowRecord] = useState(false);
  const { events, aggregates, handlers } = useInputProvenance();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const dirty = useRef(false);

  const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

  const save = useCallback(async () => {
    if (!dirty.current) return;
    dirty.current = false;
    setStatus("Saving…");
    try {
      const evidence = [
        `typed_words:${aggregates.modeWords["typed"] ?? words}`,
        ...events.map((e) => `${e.inputMode}:${e.wordCount}`),
      ];
      const res = await fetch(
        `${API}/v1/repositories/${owner}/${slug}/documents/${path}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: text, message: `Write ${path.split("/").pop()}`, evidence }),
        },
      );
      if (!res.ok) throw new Error(await res.text());
      const result = (await res.json()) as { sha: string; provenance: string };
      setSaved(true);
      setStatus(`Saved · ${result.sha.slice(0, 7)} · recorded as ${result.provenance}`);
    } catch {
      dirty.current = true;
      setStatus("Could not save — the API may not be running");
    }
  }, [aggregates.modeWords, events, owner, path, slug, text, words]);

  // Autosave on a pause, so a session becomes a continuous record rather than
  // a handful of large jumps.
  useEffect(() => {
    if (saved) return;
    const id = setTimeout(() => void save(), 2500);
    return () => clearTimeout(id);
  }, [text, saved, save]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); void save(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const pasted = events.filter((e) => e.inputMode === "pasted");

  return (
    <div className="write-shell">
      <div className="write-bar">
        <div className="wrap write-bar-inner">
          <Link href={`/${owner}/${slug}`}>← {slug}</Link>
          <span>{path.split("/").pop()}</span>
          <span className="spacer" />
          <span>{words.toLocaleString()} words</span>
          <button className="btn secondary" onClick={() => setShowRecord((s) => !s)}>
            Session record
          </button>
          <span className={saved ? "saved" : "pending"}>{status ?? (saved ? "Saved" : "Unsaved")}</span>
        </div>
      </div>

      {showRecord && (
        <div className="wrap">
          <div className="notice">
            <strong>What this session recorded.</strong> Typing is counted, never logged — no
            keystroke content leaves your browser.
            <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
              <li>{aggregates.keystrokes.toLocaleString()} keystrokes{aggregates.medianWpm ? `, about ${aggregates.medianWpm} wpm` : ""}</li>
              <li>
                {pasted.length === 0
                  ? "No pastes over the threshold."
                  : `${pasted.length} paste${pasted.length === 1 ? "" : "s"} of ${pasted.reduce((n, e) => n + e.wordCount, 0)} words total.`}
              </li>
            </ul>
            {pasted.length > 0 && (
              <p style={{ marginBottom: 0 }}>
                Pasting is normal — your own notes, an earlier draft, a scene you cut. It is
                recorded as a fact, not a suspicion. You can note where it came from, and your
                note is stored as your account of it, separate from what we observed.
              </p>
            )}
          </div>
        </div>
      )}

      <div className="write-area">
        <textarea
          ref={textarea}
          className="composer"
          value={text}
          placeholder="Begin."
          spellCheck
          onChange={(e) => { setText(e.target.value); setSaved(false); dirty.current = true; }}
          {...handlers}
        />
      </div>
    </div>
  );
}
