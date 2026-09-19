import { describe, expect, it } from "vitest";
import { normalize, denormalize, countWords } from "./normalize.js";
import { segmentSentences } from "./segment.js";
import { splitBlocks } from "./blocks.js";

describe("segmentSentences", () => {
  it("splits plain sentences", () => {
    expect(segmentSentences("One thing happened. Then another.")).toEqual([
      "One thing happened.",
      "Then another.",
    ]);
  });

  it("does not split on titles", () => {
    expect(segmentSentences("Mr. Alden came at dawn.")).toEqual(["Mr. Alden came at dawn."]);
    expect(segmentSentences("She asked Dr. Reyes to wait.")).toEqual([
      "She asked Dr. Reyes to wait.",
    ]);
  });

  it("does not split on initials", () => {
    expect(segmentSentences("J. R. R. Tolkien wrote it.")).toEqual([
      "J. R. R. Tolkien wrote it.",
    ]);
  });

  it("does not split on dotted abbreviations", () => {
    expect(segmentSentences("The lamp, e.g. the brass one, was gone.")).toEqual([
      "The lamp, e.g. the brass one, was gone.",
    ]);
  });

  it("treats ambiguous abbreviations by what follows", () => {
    // continuing sentence -> one
    expect(segmentSentences("Apples, oranges, etc. were in the crate.")).toHaveLength(1);
    // new sentence -> two
    expect(segmentSentences("Apples, oranges, etc. Then she left.")).toHaveLength(2);
  });

  it("keeps dialogue attribution with its sentence", () => {
    expect(segmentSentences('"I won\'t," she said.')).toEqual(['"I won\'t," she said.']);
  });

  it("splits dialogue that ends a sentence", () => {
    expect(segmentSentences('"Stop." She turned away.')).toHaveLength(2);
  });

  it("does not split decimals", () => {
    expect(segmentSentences("The tide rose 3.5 metres overnight.")).toHaveLength(1);
  });

  it("keeps mid-sentence ellipsis together", () => {
    expect(segmentSentences("She paused… then spoke.")).toHaveLength(1);
  });
});

describe("normalize", () => {
  it("puts one sentence per line", () => {
    const input = "The lighthouse had been dark for eleven years. Mara counted them.";
    expect(normalize(input)).toBe(
      "The lighthouse had been dark for eleven years.\nMara counted them.\n",
    );
  });

  it("is idempotent", () => {
    const input = "First. Second. Third one here.\n\nA new paragraph begins. It ends.\n";
    const once = normalize(input);
    expect(normalize(once)).toBe(once);
  });

  it("preserves paragraph breaks", () => {
    const out = normalize("One. Two.\n\nThree. Four.");
    expect(out).toBe("One.\nTwo.\n\nThree.\nFour.\n");
  });

  it("rejoins a hard-wrapped paragraph before splitting", () => {
    const wrapped = "The road gave out at the\nheadland. She walked the rest.";
    expect(normalize(wrapped)).toBe("The road gave out at the headland.\nShe walked the rest.\n");
  });

  it("leaves frontmatter untouched", () => {
    const doc = "---\nchapter: 1\ntitle: The Lighthouse. Really.\n---\n\nOne. Two.";
    const out = normalize(doc);
    expect(out).toContain("---\nchapter: 1\ntitle: The Lighthouse. Really.\n---");
    expect(out).toContain("One.\nTwo.");
  });

  it("leaves fenced code untouched", () => {
    const doc = "Before. Here.\n\n```\nconst a = 1. Not prose.\n```\n\nAfter. Done.";
    const out = normalize(doc);
    expect(out).toContain("const a = 1. Not prose.");
    expect(out).toContain("Before.\nHere.");
  });

  it("leaves headings and lists untouched", () => {
    const doc = "# Chapter One. Part Two.\n\n- first. item\n- second. item";
    const out = normalize(doc);
    expect(out).toContain("# Chapter One. Part Two.");
    expect(out).toContain("- first. item\n- second. item");
  });

  it("normalizes CRLF input", () => {
    expect(normalize("One. Two.\r\n\r\nThree.")).toBe("One.\nTwo.\n\nThree.\n");
  });
});

describe("denormalize", () => {
  it("inverts normalize for paragraphs", () => {
    const original = "One thing. Another thing.\n\nA second paragraph. With two.\n";
    expect(denormalize(normalize(original))).toBe(
      "One thing. Another thing.\n\nA second paragraph. With two.\n",
    );
  });
});

describe("countWords", () => {
  it("counts prose and skips code and frontmatter", () => {
    const doc = "---\ntitle: x\n---\n\nThe tide came in fast.\n\n```\nignored code here\n```\n";
    expect(countWords(doc)).toBe(5);
  });

  it("counts hyphenated and apostrophed words once", () => {
    expect(countWords("It was a half-lit room, wasn't it?")).toBe(7);
  });
});

describe("splitBlocks", () => {
  it("classifies block kinds", () => {
    const doc = "---\na: 1\n---\n\n# H\n\npara here\n\n- item\n\n> quote\n\n```\ncode\n```";
    const kinds = splitBlocks(doc).map((b) => b.kind);
    expect(kinds).toEqual(["frontmatter", "heading", "paragraph", "list", "blockquote", "code"]);
  });
});
