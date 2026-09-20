import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as ort from "onnxruntime-web";
import { PINNED_MODEL, EMBEDDER_ID, PUBLISHED_PRECISION } from "./pinned.js";
import { encode, loadTokenizer, type TokenizerConfig } from "./tokenizer.js";

/**
 * Local embedding (§2.7, §4).
 *
 * Runs entirely on this machine: no hosted API, no network at inference time,
 * nothing about an unpublished manuscript leaving the process. That is both a
 * reproducibility property and a privacy one — a premise sent to a hosted
 * embedding service is a premise disclosed.
 */

export interface Embedder {
  readonly id: string;
  readonly dimensions: number;
  readonly weightsHash: string;
  embed(texts: string[]): Promise<Float32Array[]>;
  close(): Promise<void>;
}

export interface ModelFiles { modelPath: string; tokenizerPath: string }

/** Where the weights live, by convention. Overridable for tests and CI. */
export function defaultModelDir(): string {
  return process.env.GITLIT_MODEL_DIR ?? path.resolve(process.cwd(), ".models", PINNED_MODEL.id);
}

export function modelFiles(dir = defaultModelDir()): ModelFiles {
  return {
    modelPath: path.join(dir, "model_quantized.onnx"),
    tokenizerPath: path.join(dir, "tokenizer.json"),
  };
}

export function modelIsPresent(dir = defaultModelDir()): boolean {
  const files = modelFiles(dir);
  return fs.existsSync(files.modelPath) && fs.existsSync(files.tokenizerPath);
}

export const shortHash = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex").slice(0, 24);

class OnnxEmbedder implements Embedder {
  readonly id = EMBEDDER_ID;
  readonly dimensions = PINNED_MODEL.dimensions;

  constructor(
    private readonly session: ort.InferenceSession,
    private readonly tokenizer: TokenizerConfig,
    readonly weightsHash: string,
  ) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    // One text per run: batching pads to the longest sequence, and padding
    // changes the result for the shorter ones. Reproducibility must not depend
    // on what a text happened to be batched with.
    for (const text of texts) out.push(await this.embedOne(text));
    return out;
  }

  private async embedOne(text: string): Promise<Float32Array> {
    const ids = encode(text, this.tokenizer, PINNED_MODEL.maxTokens);
    const big = BigInt64Array.from(ids.map((v) => BigInt(v)));
    const ones = BigInt64Array.from(ids.map(() => 1n));
    const zeros = BigInt64Array.from(ids.map(() => 0n));

    const result = await this.session.run({
      input_ids: new ort.Tensor("int64", big, [1, ids.length]),
      attention_mask: new ort.Tensor("int64", ones, [1, ids.length]),
      token_type_ids: new ort.Tensor("int64", zeros, [1, ids.length]),
    });

    const tensor = result[this.session.outputNames[0]!]!;
    const [, , dim] = tensor.dims as [number, number, number];
    const data = tensor.data as Float32Array;

    // bge pools the [CLS] token, which is position 0.
    const vector = new Float32Array(dim);
    for (let d = 0; d < dim; d++) vector[d] = data[d]!;

    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dim; d++) vector[d]! /= norm;
    return vector;
  }

  async close(): Promise<void> {
    await this.session.release?.();
  }
}

function wasmDirectory(): string {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("onnxruntime-web");
  return pathToFileURL(path.join(path.dirname(entry), "/")).href;
}

let cached: Promise<Embedder> | null = null;

/**
 * Load the embedder.
 *
 * Returns null when the weights are simply absent — the model is a 33MB
 * artefact fetched separately, and a GitLit without it should still run and
 * say which scorer it used rather than fail to start.
 *
 * THROWS when the weights are present but unusable: wrong hash, corrupt file,
 * missing runtime. An earlier version swallowed those too, which meant a
 * pinning failure looked exactly like "no model installed" and the message
 * explaining it never reached anyone.
 */
export async function loadEmbedder(dir = defaultModelDir()): Promise<Embedder | null> {
  if (!modelIsPresent(dir)) return null;
  cached ??= createEmbedder(dir);
  try {
    return await cached;
  } catch (error) {
    cached = null;
    throw error;
  }
}

async function createEmbedder(dir: string): Promise<Embedder> {
  const files = modelFiles(dir);
  const weights = fs.readFileSync(files.modelPath);
  const hash = shortHash(weights);

  if (hash !== PINNED_MODEL.weightsSha256) {
    throw new Error(
      `Model weights at ${files.modelPath} hash ${hash}, but this build is pinned to ` +
      `${PINNED_MODEL.weightsSha256}. Refusing to score with unpinned weights: ` +
      `published similarities would not be reproducible. Run 'pnpm fetch-model'.`,
    );
  }

  ort.env.wasm.numThreads = 1;      // threading changes float accumulation order
  ort.env.wasm.proxy = false;
  ort.env.logLevel = "error";
  // Resolved through the package graph rather than a relative path: the
  // location of the runtime's .wasm files depends on how the installer
  // hoisted them, which is not something source layout can assume.
  ort.env.wasm.wasmPaths = wasmDirectory();

  const session = await ort.InferenceSession.create(weights, {
    executionProviders: ["wasm"],
    // Graph optimisation may reassociate float operations; disabling it keeps
    // the computation identical across onnxruntime releases.
    graphOptimizationLevel: "disabled",
  });

  const tokenizer = loadTokenizer(JSON.parse(fs.readFileSync(files.tokenizerPath, "utf8")));
  return new OnnxEmbedder(session, tokenizer, hash);
}

/** Cosine similarity of two L2-normalised vectors, rounded to what we publish. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  const clamped = Math.max(-1, Math.min(1, dot));
  return Number(clamped.toFixed(PUBLISHED_PRECISION));
}

export { PINNED_MODEL, EMBEDDER_ID, PUBLISHED_PRECISION };
