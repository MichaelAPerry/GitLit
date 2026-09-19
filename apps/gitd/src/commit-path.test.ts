import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateSigningKey, parseMessage, receiptsFromJsonl, verifyChain } from "@gitlit/provenance";
import { assertAgentWritable } from "@gitlit/core";
import { initRepo, readFileAt, log } from "./repo.js";
import { writeCommit } from "./commit-path.js";

const key = generateSigningKey("key_test");
const author = { name: "Mara", email: "mara@example.com", id: "u_1" };

let gitdir: string;
let t = 1_700_000_000;

beforeEach(async () => {
  gitdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gitlit-"));
  await initRepo(gitdir);
  t += 1000;
});
afterEach(async () => { await fs.promises.rm(gitdir, { recursive: true, force: true }); });

const write = (changes: { path: string; content: string | null }[], opts: Partial<Parameters<typeof writeCommit>[0]> = {}) =>
  writeCommit({
    gitdir, repoId: "repo_1", ref: "refs/heads/main", changes,
    message: "Update", author, newTextOrigin: "human_written", signingKey: key,
    timestamp: (t += 10), ...opts,
  });

describe("commit path", () => {
  it("normalizes prose on write", async () => {
    await write([{ path: "manuscript/chapters/01.md", content: "One thing. Two things." }]);
    const stored = await readFileAt(gitdir, "refs/heads/main", "manuscript/chapters/01.md");
    expect(stored).toBe("One thing.\nTwo things.\n");
  });

  it("leaves non-prose files alone", async () => {
    await write([{ path: "book.yml", content: "title: A. Novel\n" }]);
    expect(await readFileAt(gitdir, "refs/heads/main", "book.yml")).toBe("title: A. Novel\n");
  });

  it("writes a provenance sidecar beside the prose", async () => {
    await write([{ path: "manuscript/chapters/01.md", content: "The tide came in." }]);
    const sidecar = await readFileAt(
      gitdir, "refs/heads/main", ".gitlit/provenance/manuscript/chapters/01.md.jsonl",
    );
    expect(sidecar).toBeTruthy();
    expect(JSON.parse(sidecar!.trim()).origin).toBe("human_written");
  });

  it("stamps trailers that survive a plain git log", async () => {
    const r = await write([{ path: "manuscript/chapters/01.md", content: "The tide came in." }]);
    const entries = await log(gitdir, "refs/heads/main", 5);
    const commit = entries.find((e) => e.oid === r.sha)!;
    const parsed = parseMessage(commit.commit.message);
    expect(parsed.provenance).toBe("human");
    expect(parsed.spansDigest).toBe(r.spansDigest);
    expect(parsed.configVersion).toBe("spans/v1");
  });

  it("derives the commit class from spans rather than the caller", async () => {
    const r = await write(
      [{ path: "manuscript_architecture.md", content: "# Plan\n\nBeat one. Beat two." }],
      { newTextOrigin: "ai_generated", agentSessionId: "sess_1", declaredModel: "claude-opus-5" },
    );
    expect(r.provenance).toBe("ai");
  });

  it("records an edit of AI text as hybrid", async () => {
    await write([{ path: "manuscript_architecture.md", content: "Beat one here. Beat two here." }],
      { newTextOrigin: "ai_generated", agentSessionId: "sess_1" });
    const r2 = await write(
      [{ path: "manuscript_architecture.md", content: "Beat one here. Beat two now here." }],
      { newTextOrigin: "human_written" },
    );
    expect(r2.provenance).toBe("hybrid");
  });

  it("counts words added across revisions", async () => {
    const r1 = await write([{ path: "manuscript/chapters/01.md", content: "One two three four five." }]);
    expect(r1.wordsAdded).toBe(5);
    const r2 = await write([
      { path: "manuscript/chapters/01.md", content: "One two three four five. Six seven." },
    ]);
    expect(r2.wordsAdded).toBe(2);
  });

  it("issues a receipt chain that verifies", async () => {
    await write([{ path: "manuscript/chapters/01.md", content: "First sentence here." }]);
    await write([{ path: "manuscript/chapters/01.md", content: "First sentence here. Second one." }]);
    const chainText = await readFileAt(gitdir, "refs/heads/main", ".gitlit/receipts/chain.jsonl");
    const chain = receiptsFromJsonl(chainText!);
    expect(chain).toHaveLength(2);
    const result = verifyChain(chain, new Map([["key_test", key.publicKey]]));
    expect(result.valid).toBe(true);
  });

  it("breaks chain verification if a receipt is removed", async () => {
    await write([{ path: "manuscript/chapters/01.md", content: "A first sentence." }]);
    await write([{ path: "manuscript/chapters/01.md", content: "A first sentence. A second." }]);
    await write([{ path: "manuscript/chapters/01.md", content: "A first sentence. A second. A third." }]);
    const chain = receiptsFromJsonl(
      (await readFileAt(gitdir, "refs/heads/main", ".gitlit/receipts/chain.jsonl"))!,
    );
    const tampered = [chain[0]!, chain[2]!];
    expect(verifyChain(tampered, new Map([["key_test", key.publicKey]])).valid).toBe(false);
  });

  it("preserves provenance of untouched sentences across a revision", async () => {
    await write([{ path: "manuscript_architecture.md", content: "Machine one. Machine two." }],
      { newTextOrigin: "ai_generated", agentSessionId: "sess_1" });
    const r = await write(
      [{ path: "manuscript_architecture.md", content: "Machine one. Machine two. Human three." }],
      { newTextOrigin: "human_written" },
    );
    const spans = r.spansByPath["manuscript_architecture.md"]!;
    expect(spans.some((s) => s.origin === "ai_generated")).toBe(true);
    expect(spans.some((s) => s.origin === "human_written")).toBe(true);
  });

  it("deletes a file and its sidecar together", async () => {
    await write([{ path: "manuscript/chapters/01.md", content: "Gone soon." }]);
    await write([{ path: "manuscript/chapters/01.md", content: null }]);
    expect(await readFileAt(gitdir, "refs/heads/main", "manuscript/chapters/01.md")).toBeNull();
    expect(await readFileAt(
      gitdir, "refs/heads/main", ".gitlit/provenance/manuscript/chapters/01.md.jsonl",
    )).toBeNull();
  });

  it("tracks machine share falling as the author writes", async () => {
    const r1 = await write([{ path: "manuscript_architecture.md", content: "Machine one. Machine two." }],
      { newTextOrigin: "ai_generated", agentSessionId: "sess_1" });
    const r2 = await write([{
      path: "manuscript_architecture.md",
      content: "Machine one. Machine two. Human three. Human four. Human five. Human six.",
    }], { newTextOrigin: "human_written" });
    expect(r2.machineShare).toBeLessThan(r1.machineShare);
  });
});

describe("agent write allowlist (§8.3)", () => {
  it("permits the architecture document", () => {
    expect(() => assertAgentWritable("manuscript_architecture.md")).not.toThrow();
  });
  it("permits .gitlit paths", () => {
    expect(() => assertAgentWritable(".gitlit/research/ledger.jsonl")).not.toThrow();
  });
  it("refuses manuscript prose", () => {
    expect(() => assertAgentWritable("manuscript/chapters/01.md")).toThrow(/refused/);
  });
  it("refuses traversal out of the repo", () => {
    expect(() => assertAgentWritable("../../etc/passwd")).toThrow(/Illegal path/);
  });
});
