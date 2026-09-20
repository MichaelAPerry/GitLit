import { toolRejected } from "@gitlit/core";
import {
  parseArchitecture,
  type ParsedArchitecture,
} from "@gitlit/prose";
import type { Ledger } from "./ledger.js";

export { parseArchitecture, type ParsedArchitecture };

/**
 * Validation for `manuscript_architecture.md` (§6.3, §8.3).
 *
 * Two jobs. First, keep the document parseable, because the Provenance Diff
 * Viewer reads beats out of it (§9.1) and an unparseable plan silently breaks
 * the flagship view. Second, and more importantly: every `S-` citation must
 * correspond to a ledger row from THIS session. A model that invents a source
 * fails here rather than producing a document that looks researched.
 */

/** Sections a committable architecture must contain (§6.3). */
const REQUIRED_SECTIONS = [
  { heading: /^##\s*1\.\s*Premise/im, name: "1. Premise (as submitted)" },
  { heading: /^##\s*2\.\s*Novelty Assessment/im, name: "2. Novelty Assessment" },
  { heading: /^##\s*3\.\s*Research Ledger/im, name: "3. Research Ledger" },
  { heading: /^##\s*4\.\s*Chapter Outline/im, name: "4. Chapter Outline" },
  { heading: /^##\s*6\.\s*Where the AI stopped/im, name: "6. Where the AI stopped" },
];

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
