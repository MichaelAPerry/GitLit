#!/usr/bin/env node
/**
 * Fetch the pinned embedding model.
 *
 * The weights are a 33MB binary, so they are not in the repository — but the
 * hash is, and this refuses anything that does not match it. Scoring with
 * unpinned weights would produce similarities nobody else could reproduce,
 * which is worse than not scoring at all.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const MODEL_ID = "bge-small-en-v1.5";
const EXPECTED = "6c9c6101a956d62dfb5e7190";
const BASE = "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main";
const FILES = [
  { name: "model_quantized.onnx", url: `${BASE}/onnx/model_quantized.onnx`, verify: true },
  { name: "tokenizer.json", url: `${BASE}/tokenizer.json`, verify: false },
];

const dir = process.env.GITLIT_MODEL_DIR ?? path.resolve(process.cwd(), ".models", MODEL_ID);
fs.mkdirSync(dir, { recursive: true });

for (const file of FILES) {
  const target = path.join(dir, file.name);
  if (fs.existsSync(target)) {
    console.log(`have ${file.name}`);
    continue;
  }
  process.stdout.write(`fetching ${file.name}… `);
  const res = await fetch(file.url, { redirect: "follow" });
  if (!res.ok) {
    console.error(`\nfailed: ${file.url} returned ${res.status}`);
    process.exit(1);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(target, bytes);
  console.log(`${(bytes.length / 1e6).toFixed(1)}MB`);

  if (file.verify) {
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 24);
    if (hash !== EXPECTED) {
      fs.unlinkSync(target);
      console.error(`hash mismatch: got ${hash}, pinned to ${EXPECTED}. Removed.`);
      process.exit(1);
    }
    console.log(`verified ${hash}`);
  }
}
console.log(`\nmodel ready in ${dir}`);
