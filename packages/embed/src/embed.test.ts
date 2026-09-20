import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  loadEmbedder, modelIsPresent, modelFiles, cosine, shortHash,
  PINNED_MODEL, EMBEDDER_ID, type Embedder,
} from "./embedder.js";
import { encode, loadTokenizer, basicTokenize, wordpiece, type TokenizerConfig } from "./tokenizer.js";

const MODEL_DIR = process.env.GITLIT_MODEL_DIR
  ?? path.resolve(process.cwd(), "../../.models/bge-small-en-v1.5");
const present = modelIsPresent(MODEL_DIR);

/**
 * The inference tests need the 33MB pinned model, which is fetched rather
 * than committed. They skip cleanly when it is absent instead of failing —
 * but the tokenizer and the pinning rules are covered either way.
 */
const withModel = present ? describe : describe.skip;

// ------------------------------------------------------------- tokenizer

describe("tokenizer", () => {
  let config: TokenizerConfig;
  beforeAll(() => {
    const raw = present
      ? JSON.parse(fs.readFileSync(modelFiles(MODEL_DIR).tokenizerPath, "utf8"))
      : { model: { vocab: {
          "[UNK]": 100, "[CLS]": 101, "[SEP]": 102,
          the: 1996, lighthouse: 15593, had: 2018, been: 2042, dark: 2601,
          light: 2422, "##house": 4580, ".": 1012, ",": 1010, keeper: 10682,
        } }, normalizer: { lowercase: true, strip_accents: true } };
    config = loadTokenizer(raw);
  });

  it("lowercases and strips accents", () => {
    expect(basicTokenize("Café NAÏVE", config)).toEqual(["cafe", "naive"]);
  });

  it("splits punctuation from words", () => {
    expect(basicTokenize("dark, for years.", config)).toEqual(["dark", ",", "for", "years", "."]);
  });

  it("collapses arbitrary whitespace", () => {
    expect(basicTokenize("  the   lighthouse \n was ", config))
      .toEqual(["the", "lighthouse", "was"]);
  });

  it("wraps encodings in [CLS] and [SEP]", () => {
    const ids = encode("the lighthouse", config, 512);
    expect(ids[0]).toBe(config.vocab["[CLS]"]);
    expect(ids[ids.length - 1]).toBe(config.vocab["[SEP]"]);
  });

  it("splits an unknown word into known subwords", () => {
    const local: TokenizerConfig = { ...config, vocab: { ...config.vocab } };
    expect(wordpiece("lighthouse", local)).toBeTruthy();
    // "light" + "##house" when "lighthouse" itself is absent.
    delete local.vocab["lighthouse"];
    expect(wordpiece("lighthouse", local)).toEqual(["light", "##house"]);
  });

  it("returns UNK for a word it cannot decompose at all", () => {
    // The real vocabulary contains single letters and their ## forms, so an
    // undecomposable word needs a character the vocabulary does not hold.
    expect(wordpiece("\u{10FFFD}\u{10FFFE}", config)).toEqual([config.unkToken]);
  });

  it("returns UNK for an absurdly long token rather than churning", () => {
    expect(wordpiece("a".repeat(500), config)).toEqual([config.unkToken]);
  });

  it("truncates deterministically at the model's limit", () => {
    const long = "the lighthouse ".repeat(2000);
    const ids = encode(long, config, 512);
    expect(ids.length).toBeLessThanOrEqual(512);
    expect(encode(long, config, 512)).toEqual(ids);
  });

  it("is deterministic for the same input", () => {
    const a = encode("The lighthouse had been dark.", config, 512);
    const b = encode("The lighthouse had been dark.", config, 512);
    expect(a).toEqual(b);
  });

  it("rejects a tokenizer file with no vocabulary", () => {
    expect(() => loadTokenizer({ model: {} })).toThrow(/no vocabulary/);
  });
});

// ----------------------------------------------------------------- pinning

describe("pinning", () => {
  it("names the model, runtime and pooling it is pinned to", () => {
    expect(PINNED_MODEL.dimensions).toBe(384);
    expect(PINNED_MODEL.pooling).toBe("cls");
    expect(PINNED_MODEL.runtime).toContain("wasm");
    expect(EMBEDDER_ID).toContain(PINNED_MODEL.version);
  });

  it("reports absence rather than throwing when no model is installed", async () => {
    expect(await loadEmbedder("/nonexistent/model/dir")).toBeNull();
  });

  it("REFUSES UNPINNED WEIGHTS — an unreproducible score is worse than none", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), "tmp-model-"));
    try {
      fs.writeFileSync(path.join(dir, "model_quantized.onnx"), "not the pinned weights");
      fs.writeFileSync(path.join(dir, "tokenizer.json"), "{}");
      const bytes = fs.readFileSync(path.join(dir, "model_quantized.onnx"));
      expect(shortHash(bytes)).not.toBe(PINNED_MODEL.weightsSha256);
      // Present but wrong must be loud. Reporting it as "no model installed"
      // would hide a pinning failure behind an ordinary, expected state.
      await expect(loadEmbedder(dir)).rejects.toThrow(/pinned to/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cosine", () => {
  it("is 1 for identical vectors", () => {
    const v = new Float32Array([0.6, 0.8]);
    expect(cosine(v, v)).toBe(1);
  });
  it("is 0 for orthogonal vectors", () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0);
  });
  it("is negative for opposed vectors", () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([-1, 0]))).toBe(-1);
  });
  it("returns 0 rather than throwing on a dimension mismatch", () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([1, 0, 0]))).toBe(0);
  });
  it("rounds to the precision that is actually published", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0.9999994, 0.001]);
    expect(String(cosine(a, b)).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(4);
  });
});

// --------------------------------------------------------------- inference

withModel("embedding (requires the pinned model)", () => {
  let embedder: Embedder;
  beforeAll(async () => { embedder = (await loadEmbedder(MODEL_DIR))!; });
  afterAll(async () => { await embedder?.close(); });

  const digest = (v: Float32Array) =>
    createHash("sha256").update(Buffer.from(v.buffer)).digest("hex").slice(0, 16);

  it("produces a normalised vector of the pinned width", async () => {
    const [v] = await embedder.embed(["The lighthouse had been dark for eleven years."]);
    expect(v!.length).toBe(384);
    const norm = Math.sqrt([...v!].reduce((n, x) => n + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("IS BIT-IDENTICAL ACROSS RUNS — the property receipts depend on", async () => {
    const text = "A lighthouse keeper's daughter returns to the island.";
    const first = await embedder.embed([text]);
    const second = await embedder.embed([text]);
    expect(digest(second[0]!)).toBe(digest(first[0]!));
  });

  it("does not let batching change a result", async () => {
    // Padding to a neighbour's length would silently alter the shorter text.
    const alone = await embedder.embed(["Short."]);
    const batched = await embedder.embed(["Short.", "A considerably longer sentence for contrast."]);
    expect(digest(batched[0]!)).toBe(digest(alone[0]!));
  });

  it("scores related premises above unrelated ones", async () => {
    const [premise, near, far] = await embedder.embed([
      "A lighthouse keeper's daughter returns to the island she swore to leave.",
      "The daughter of a lighthouse keeper comes back to the island of her childhood.",
      "A manual for cultivating root vegetables aboard an orbital station.",
    ]);
    const similar = cosine(premise!, near!);
    const different = cosine(premise!, far!);
    expect(similar).toBeGreaterThan(different);
    expect(similar).toBeGreaterThan(0.8);
    expect(different).toBeLessThan(0.6);
  });

  it("SEES MEANING THAT SHARES NO WORDS — the point of doing this at all", async () => {
    // No content word in common; lexical overlap is near zero.
    const [a, b] = await embedder.embed([
      "The keeper's child came home to the island.",
      "A lighthouse warden's daughter returned to her birthplace.",
    ]);
    expect(cosine(a!, b!)).toBeGreaterThan(0.7);
  });

  it("reports the weights hash it actually loaded", () => {
    expect(embedder.weightsHash).toBe(PINNED_MODEL.weightsSha256);
    expect(embedder.dimensions).toBe(384);
  });
});
