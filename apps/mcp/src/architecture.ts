import { toolRejected } from "@gitlit/core";
import type { Ledger } from "./ledger.js";

/**
 * Validation for `manuscript_architecture.md` (§6.3, §8.3).
 *
 * Two jobs. First, keep the document parseable, because the Provenance Diff
 * Viewer reads beats out of it (§9.1) and an unparseable plan silently breaks
 * the flagship view. Second, and more importantly: every `S-` citation must
 * correspond to a ledger row from THIS session. A model that invents a source
 * fails here rather than producing a document that looks researched.
 */

export interface ParsedBeat { id: string; text: string; sources: string[] }
export interface ParsedChapter { id: string; number: number; title: string; beats: ParsedBeat[] }

export interface ParsedArchitecture {
  frontMatter: Record<string, string>;
  chapters: ParsedChapter[];
  beats: ParsedBeat[];
  citedRefs: string[];
  hasNoveltySection: boolean;
  hasLedgerSection: boolean;
  hasBoundaryStatement: boolean;
}

const REQUIRED_SECTIONS = [
  { heading: /^##\s*1\.\s*Premise/im, name: "1. Premise (as submitted)" },
  { heading: /^##\s*2\.\s*Novelty Assessment/im, name: "2. Novelty Assessment" },
  { heading: /^##\s*3\.\s*Research Ledger/im, name: "3. Research Ledger" },
  { heading: /^##\s*4\.\s*Chapter Outline/im, name: "4. Chapter Outline" },
  { heading: /^##\s*6\.\s*Where the AI stopped/im, name: "6. Where the AI stopped" },
];

export function parseArchitecture(markdown: string): ParsedArchitecture {
  const frontMatter: Record<string, string> = {};
  const fm = /^---\n([\s\S]*?)\n---/.exec(markdown);
  if (fm) {
    for (const line of fm[1]!.split("\n")) {
      const m = /^([\w_]+):\s*(.*)$/.exec(line.trim());
      if (m) frontMatter[m[1]!] = m[2]!.replace(/\s*#.*$/, "").trim();
    }
  }

  const chapters: ParsedChapter[] = [];
  const beats: ParsedBeat[] = [];

  const chapterRe = /^###\s*Chapter\s+(\d+)\s*[—–-]\s*(.+?)\s*`\[(ch\d+)\]`\s*$/gim;
  const chapterHeads = [...markdown.matchAll(chapterRe)];

  for (let i = 0; i < chapterHeads.length; i++) {
    const head = chapterHeads[i]!;
    const start = head.index! + head[0].length;
    const end = i + 1 < chapterHeads.length ? chapterHeads[i + 1]!.index! : markdown.length;
    const body = markdown.slice(start, end);

    const chapterBeats: ParsedBeat[] = [];
    const beatRe = /^-\s*`(b[\d.]+)`\s*(.+?)\s*$/gim;
    for (const bm of body.matchAll(beatRe)) {
      const text = bm[2]!;
      const sources = [...text.matchAll(/S-\d{3}/g)].map((s) => s[0]);
      const beat: ParsedBeat = { id: bm[1]!, text: text.replace(/\s*\*\(sources:[^)]*\)\*/, "").trim(), sources };
      chapterBeats.push(beat);
      beats.push(beat);
    }

    chapters.push({
      id: head[3]!, number: Number(head[1]), title: head[2]!.trim(), beats: chapterBeats,
    });
  }

  return {
    frontMatter,
    chapters,
    beats,
    citedRefs: [...new Set([...markdown.matchAll(/S-\d{3}/g)].map((m) => m[0]))],
    hasNoveltySection: REQUIRED_SECTIONS[1]!.heading.test(markdown),
    hasLedgerSection: REQUIRED_SECTIONS[2]!.heading.test(markdown),
    hasBoundaryStatement: REQUIRED_SECTIONS[4]!.heading.test(markdown),
  };
}

export interface ValidationIssue { code: string; message: string }

export function validateArchitecture(markdown: string, ledger: Ledger): ParsedArchitecture {
  const issues: ValidationIssue[] = [];
  const parsed = parseArchitecture(markdown);

  for (const section of REQUIRED_SECTIONS) {
    if (!section.heading.test(markdown)) {
      issues.push({ code: "missing_section", message: `Missing required section "${section.name}".` });
    }
  }

  if (parsed.chapters.length === 0) {
    issues.push({
      code: "no_chapters",
      message: 'No chapters parsed. Each needs "### Chapter N — Title `[chN]`".',
    });
  }
  if (parsed.beats.length === 0) {
    issues.push({ code: "no_beats", message: 'No beats parsed. Each needs "- `bN.N` text".' });
  }

  // The load-bearing check: no citing a source we never retrieved.
  const unknown = parsed.citedRefs.filter((ref) => !ledger.has(ref));
  if (unknown.length > 0) {
    issues.push({
      code: "unknown_source_ref",
      message:
        `Cited sources not in this session's ledger: ${unknown.join(", ")}. ` +
        `Every S- reference must come from gitlit_search_prior_works or ` +
        `gitlit_add_source. Available: ${ledger.refs().join(", ") || "(none yet)"}.`,
    });
  }

  const duplicateBeats = parsed.beats
    .map((b) => b.id)
    .filter((id, i, all) => all.indexOf(id) !== i);
  if (duplicateBeats.length > 0) {
    issues.push({
      code: "duplicate_beat_id",
      message: `Duplicate beat ids: ${[...new Set(duplicateBeats)].join(", ")}.`,
    });
  }

  if (issues.length > 0) {
    throw toolRejected(
      issues[0]!.code,
      `manuscript_architecture.md was rejected:\n` +
        issues.map((i) => `  • ${i.message}`).join("\n"),
    );
  }
  return parsed;
}

/** Assemble front matter so provenance metadata is never the agent's to write. */
export function buildFrontMatter(input: {
  sessionId: string; declaredModel?: string; clientName?: string;
  premiseHash: string; verdict?: string; scorerVersion: string;
}): string {
  return [
    "---",
    "gitlit_version: 1",
    `agent_session: ${input.sessionId}`,
    `generated_at: ${new Date().toISOString()}`,
    `declared_model: ${input.declaredModel ?? "unstated"}   # agent claim, unverified`,
    `mcp_client: ${input.clientName ?? "unknown"}`,
    `premise_hash: ${input.premiseHash}`,
    `novelty_verdict: ${input.verdict ?? "not_assessed"}`,
    `novelty_scorer: ${input.scorerVersion}`,
    "---",
  ].join("\n");
}
