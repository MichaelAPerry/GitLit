/**
 * Parsing for `manuscript_architecture.md` (§6.3).
 *
 * Lives here rather than beside the MCP server because two very different
 * callers need it: the agent tooling, to validate a document before committing
 * it, and the Provenance Diff Viewer, to read the beats a chapter is compared
 * against (§9.1). Validation stays with the MCP server, since only that side
 * has a research ledger to check citations against.
 */

export interface ParsedBeat {
  id: string;
  text: string;
  /** Ledger refs the beat cites, e.g. ["S-014"]. */
  sources: string[];
  /** The chapter this beat belongs to, e.g. "ch1". */
  chapterId: string;
}
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
      const beat: ParsedBeat = {
        id: bm[1]!,
        text: text.replace(/\s*\*\(sources:[^)]*\)\*/, "").trim(),
        sources,
        chapterId: head[3]!,
      };
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
    hasNoveltySection: /^##\s*2\.\s*Novelty Assessment/im.test(markdown),
    hasLedgerSection: /^##\s*3\.\s*Research Ledger/im.test(markdown),
    hasBoundaryStatement: /^##\s*6\.\s*Where the AI stopped/im.test(markdown),
  };
}

