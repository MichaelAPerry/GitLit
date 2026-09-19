export type BlockKind =
  | "frontmatter" | "code" | "heading" | "list" | "table"
  | "blockquote" | "html" | "thematic" | "paragraph";

export interface Block {
  kind: BlockKind;
  /** Verbatim source lines. Only `paragraph` blocks are ever rewritten. */
  lines: string[];
}

const FENCE = /^(\s*)(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})\s/;
const LIST = /^\s{0,3}([-*+]|\d{1,9}[.)])\s/;
const QUOTE = /^\s{0,3}>/;
const TABLE = /^\s{0,3}\|/;
const HTML = /^\s{0,3}<[a-zA-Z!/]/;
const THEMATIC = /^\s{0,3}((-\s*){3,}|(\*\s*){3,}|(_\s*){3,})$/;

function classify(lines: string[]): BlockKind {
  const first = lines[0] ?? "";
  if (THEMATIC.test(first)) return "thematic";
  if (HEADING.test(first)) return "heading";
  if (LIST.test(first)) return "list";
  if (QUOTE.test(first)) return "blockquote";
  if (TABLE.test(first)) return "table";
  if (HTML.test(first)) return "html";
  return "paragraph";
}

/**
 * Split a Markdown document into blocks. Fenced code and YAML frontmatter are
 * captured whole so the normalizer never reaches inside them.
 */
export function splitBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === "---");
    if (end > 0) {
      blocks.push({ kind: "frontmatter", lines: lines.slice(0, end + 1) });
      i = end + 1;
    }
  }

  let buf: string[] = [];
  const flush = () => {
    while (buf.length && buf[buf.length - 1]!.trim() === "") buf.pop();
    while (buf.length && buf[0]!.trim() === "") buf.shift();
    if (buf.length) blocks.push({ kind: classify(buf), lines: buf });
    buf = [];
  };

  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const marker = fence[2]!;
      const code = [line];
      i++;
      for (; i < lines.length; i++) {
        code.push(lines[i]!);
        if (lines[i]!.trimStart().startsWith(marker)) break;
      }
      blocks.push({ kind: "code", lines: code });
      continue;
    }
    if (line.trim() === "") flush();
    else buf.push(line);
  }
  flush();
  return blocks;
}
