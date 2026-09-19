import { splitBlocks, type Block } from "./blocks.js";
import { segmentSentences } from "./segment.js";

/**
 * Canonical on-disk form: Markdown with one sentence per line (§2.2).
 *
 * This is what makes Git's line-oriented diff meaningful for prose — a
 * one-word fix produces a one-line diff instead of repainting the paragraph.
 * Authors never see it; the editor renders flowing text.
 *
 * Only `paragraph` blocks are rewritten. Headings, lists, tables, quotes,
 * code and frontmatter pass through verbatim.
 *
 * Idempotent: normalize(normalize(x)) === normalize(x).
 */
export function normalize(source: string): string {
  const blocks = splitBlocks(source);
  const out = blocks.map((b) =>
    b.kind === "paragraph" ? segmentSentences(b.lines.join(" ")).join("\n") : b.lines.join("\n"),
  );
  const body = out.filter((b) => b.length > 0).join("\n\n");
  return body.endsWith("\n") ? body : `${body}\n`;
}

/**
 * Inverse for export and for the editor: rejoin sentence lines into flowing
 * paragraphs. Not exactly lossless against arbitrary input — it is the inverse
 * of `normalize`, not of hand-formatted Markdown.
 */
export function denormalize(source: string): string {
  const blocks = splitBlocks(source);
  const out = blocks.map((b) =>
    b.kind === "paragraph" ? b.lines.map((l) => l.trim()).join(" ") : b.lines.join("\n"),
  );
  const body = out.filter((b) => b.length > 0).join("\n\n");
  return body.endsWith("\n") ? body : `${body}\n`;
}

/** Prose word count: excludes frontmatter, code, tables and HTML. */
export function countWords(source: string): number {
  const blocks = splitBlocks(source);
  let n = 0;
  for (const b of blocks) {
    if (b.kind === "frontmatter" || b.kind === "code" || b.kind === "table" || b.kind === "html")
      continue;
    // Strip markers without touching intra-word punctuation: a blanket
    // character class would turn "half-lit" into two words.
    const text = b.lines
      .map((l) => l.replace(/^\s{0,3}(?:[-*+]|\d{1,9}[.)]|#{1,6}|>)\s+/, ""))
      .join(" ")
      .replace(/[*_`~]/g, " ")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
    n += (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
  }
  return n;
}

/** Sentence lines of the normalized document, with their line index. */
export function sentenceLines(source: string): { line: number; text: string }[] {
  const lines = normalize(source).split("\n");
  const blocks = splitBlocks(normalize(source));
  const proseText = new Set<string>();
  for (const b of blocks) if (b.kind === "paragraph") for (const l of b.lines) proseText.add(l);
  return lines
    .map((text, line) => ({ line, text }))
    .filter((r) => r.text.trim().length > 0 && proseText.has(r.text));
}

export type { Block };
