/**
 * The pinned embedding model (§2.7).
 *
 * Every number GitLit publishes must recompute offline, years later, from a
 * clone. For an embedding model that means pinning three things, not one:
 * the weights, the tokenizer, and the runtime that executes them.
 *
 * The runtime choice is the load-bearing one. Native ONNX dispatches to
 * platform-specific SIMD kernels, so the same weights on a different CPU can
 * return slightly different floats — enough to move a published similarity in
 * the third decimal place and make a receipt look tampered with. WebAssembly
 * has deterministic floating-point semantics by specification, so the same
 * input yields bit-identical output on every machine that can run it. That is
 * worth more here than the speed of the native build.
 */
export const PINNED_MODEL = {
  id: "bge-small-en-v1.5",
  /** Quantised ONNX export. int8 weights, 384 dimensions. */
  revision: "Xenova/bge-small-en-v1.5@onnx/model_quantized.onnx",
  weightsSha256: "6c9c6101a956d62dfb5e7190",
  dimensions: 384,
  /** bge models pool the [CLS] token rather than averaging (per the model card). */
  pooling: "cls" as const,
  maxTokens: 512,
  runtime: "onnxruntime-web/wasm",
  /** Bumped whenever anything above changes, so a stored score keeps its meaning. */
  version: "embed/bge-small-v1",
} as const;

export const EMBEDDER_ID = `${PINNED_MODEL.id}@${PINNED_MODEL.version}`;

/**
 * Published scores are rounded to this many decimals.
 *
 * Inference is bit-identical under WASM, so this is not a tolerance for
 * numerical drift — it is a guard against a future runtime or model revision
 * shifting a value in the noise. A verifier comparing to more precision than
 * this would be asserting something the pipeline does not promise.
 */
export const PUBLISHED_PRECISION = 4;
