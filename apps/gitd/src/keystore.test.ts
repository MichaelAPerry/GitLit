import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { issueReceipt, verifyReceipt, verifyChain, payloadHash } from "@gitlit/provenance";
import { KeyStore } from "./keystore.js";

let root: string;
const resolve = (repoId: string) => path.join(root, `${repoId}.git`);

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gitlit-keys-"));
  delete process.env.SIGNING_MASTER_KEY;
});
afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
  delete process.env.SIGNING_MASTER_KEY;
});

const receipt = (commit: string, prev: string | null = null) => ({
  id: `rcpt_${commit}`, repo: "repo_1", commit: commit.padEnd(40, "0"),
  spansDigest: "sha256:abc", configVersion: "spans/v1",
  issuedAt: "2026-09-19T00:00:00Z", prev,
});

describe("KeyStore", () => {
  it("returns a stable key within one process", () => {
    const store = new KeyStore(resolve);
    expect(store.for("repo_1").publicKey).toBe(store.for("repo_1").publicKey);
  });

  it("SURVIVES A RESTART — the whole point of a receipt chain", () => {
    const before = new KeyStore(resolve).for("repo_1");
    // A brand new store, as after a process restart.
    const after = new KeyStore(resolve).for("repo_1");
    expect(after.publicKey).toBe(before.publicKey);
    expect(after.keyId).toBe(before.keyId);
  });

  it("keeps receipts verifiable across a restart", () => {
    const issued = issueReceipt(receipt("a"), new KeyStore(resolve).for("repo_1"));
    const afterRestart = new KeyStore(resolve).for("repo_1");
    expect(verifyReceipt(issued, afterRestart.publicKey)).toBe(true);
  });

  it("keeps a chain spanning a restart intact", () => {
    const first = new KeyStore(resolve).for("repo_1");
    const r1 = issueReceipt(receipt("a"), first);
    const second = new KeyStore(resolve).for("repo_1");
    const r2 = issueReceipt(receipt("b", payloadHash(r1)), second);
    const result = verifyChain([r1, r2], new Map([[first.keyId, first.publicKey]]));
    expect(result.valid).toBe(true);
  });

  it("gives different repos different keys", () => {
    const store = new KeyStore(resolve);
    expect(store.for("repo_1").publicKey).not.toBe(store.for("repo_2").publicKey);
  });

  it("writes the key file with owner-only permissions", () => {
    new KeyStore(resolve).for("repo_1");
    const mode = fs.statSync(path.join(resolve("repo_1"), "gitlit-signing-key.json")).mode;
    expect(mode & 0o077).toBe(0);
  });

  it("wraps the private key at rest when a master key is set", () => {
    process.env.SIGNING_MASTER_KEY = "test-master-secret";
    new KeyStore(resolve).for("repo_1");
    const raw = fs.readFileSync(path.join(resolve("repo_1"), "gitlit-signing-key.json"), "utf8");
    expect(raw).not.toContain("PRIVATE KEY");
    expect(JSON.parse(raw).wrapped).toBe(true);
  });

  it("unwraps a wrapped key on reload", () => {
    process.env.SIGNING_MASTER_KEY = "test-master-secret";
    const before = new KeyStore(resolve).for("repo_1");
    const after = new KeyStore(resolve).for("repo_1");
    expect(after.privateKey).toBe(before.privateKey);
  });

  it("refuses to start rather than orphan a chain when the master key is missing", () => {
    process.env.SIGNING_MASTER_KEY = "test-master-secret";
    new KeyStore(resolve).for("repo_1");
    delete process.env.SIGNING_MASTER_KEY;
    expect(() => new KeyStore(resolve).for("repo_1")).toThrow(/orphan the existing chain/);
  });

  it("fails on a tampered wrapped key instead of silently regenerating", () => {
    process.env.SIGNING_MASTER_KEY = "test-master-secret";
    new KeyStore(resolve).for("repo_1");
    const file = path.join(resolve("repo_1"), "gitlit-signing-key.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.privateKey = stored.privateKey.replace(/.$/, "X");
    fs.writeFileSync(file, JSON.stringify(stored));
    expect(() => new KeyStore(resolve).for("repo_1")).toThrow();
  });
});
