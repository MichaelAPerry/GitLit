import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  generateSigningKey, receiptsFromJsonl, verifyChain,
} from "@gitlit/provenance";
import { initRepo, readFileAt, repoPath } from "./repo.js";
import { verifyRepository } from "./verify.js";
import { KeyStore } from "./keystore.js";
import { writeCommit } from "./commit-path.js";
import {
  DirectoryBackupStore, bundleRepository, discoverRepositories,
  restoreRepository, runBackup, repoIdFromPath,
} from "./backup.js";

const key = generateSigningKey("key_backup");
const author = { name: "Mara", email: "mara@example.com", id: "u_1" };

let root: string;
let backupDir: string;
let restoreDir: string;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gitlit-root-"));
  backupDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gitlit-backups-"));
  restoreDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gitlit-restore-"));
});
afterEach(async () => {
  for (const dir of [root, backupDir, restoreDir]) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

/** A directory that looks like a repository but cannot be read. */
async function makeCorruptRepository(repoId: string): Promise<string> {
  const gitdir = repoPath(root, repoId);
  await fs.promises.mkdir(path.join(gitdir, "objects"), { recursive: true });
  await fs.promises.mkdir(path.join(gitdir, "refs"), { recursive: true });
  await fs.promises.writeFile(path.join(gitdir, "HEAD"), "this is not a ref\n");
  await fs.promises.writeFile(path.join(gitdir, "config"), "[core\nbroken = ((\n");
  return gitdir;
}

/** A repository with real history: prose, provenance sidecars, receipts. */
async function seedRepository(repoId: string, chapters = 2): Promise<string> {
  const gitdir = repoPath(root, repoId);
  await initRepo(gitdir);
  // gitd persists the signing key into the gitdir via KeyStore; mirror that
  // here so the backup exercises the real on-disk arrangement.
  const store = new KeyStore(() => gitdir);
  store.for(repoId);
  let timestamp = 1_700_000_000;
  for (let i = 1; i <= chapters; i++) {
    await writeCommit({
      gitdir, repoId, ref: "refs/heads/main",
      message: `Draft chapter ${i}`,
      author, newTextOrigin: "human_written", signingKey: key,
      timestamp: (timestamp += 100),
      changes: [{
        path: `manuscript/chapters/0${i}.md`,
        content: `The lighthouse had been dark for ${i} years. Mara counted them.`,
      }],
    });
  }
  return gitdir;
}

describe("discovery", () => {
  it("finds every repository under the sharded root", async () => {
    await seedRepository("repo_AAAAAAAAAAAAAAAAAAAAAAAAAA");
    await seedRepository("repo_BBBBBBBBBBBBBBBBBBBBBBBBBB");
    const found = await discoverRepositories(root);
    expect(found).toHaveLength(2);
    expect(found.map(repoIdFromPath).sort()).toEqual([
      "repo_AAAAAAAAAAAAAAAAAAAAAAAAAA", "repo_BBBBBBBBBBBBBBBBBBBBBBBBBB",
    ]);
  });

  it("returns nothing for an empty or missing root", async () => {
    expect(await discoverRepositories(path.join(root, "nope"))).toEqual([]);
    expect(await discoverRepositories(root)).toEqual([]);
  });
});

describe("bundling", () => {
  it("produces a verifiable bundle carrying every ref", async () => {
    const gitdir = await seedRepository("repo_CCCCCCCCCCCCCCCCCCCCCCCCCC");
    const result = (await bundleRepository(gitdir, backupDir))!;
    expect(result.refs).toBeGreaterThan(0);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    // bundleRepository verifies internally; assert it independently too.
    execFileSync("git", ["bundle", "verify", path.join(backupDir, result.bundleName)]);
  });

  it("skips an empty repository instead of failing the run", async () => {
    const gitdir = repoPath(root, "repo_DDDDDDDDDDDDDDDDDDDDDDDDDD");
    await initRepo(gitdir);
    expect(await bundleRepository(gitdir, backupDir)).toBeNull();
  });
});

describe("a backup run", () => {
  it("bundles every repository and writes a manifest", async () => {
    await seedRepository("repo_EEEEEEEEEEEEEEEEEEEEEEEEEE");
    await seedRepository("repo_FFFFFFFFFFFFFFFFFFFFFFFFFF");
    const store = new DirectoryBackupStore(backupDir);

    const report = await runBackup(root, store);
    expect(report.bundled).toHaveLength(2);
    expect(report.failed).toEqual([]);

    const stored = await fs.promises.readdir(backupDir);
    expect(stored.filter((f) => f.endsWith(".bundle"))).toHaveLength(2);
    expect(stored.some((f) => f.startsWith("manifest-"))).toBe(true);
  });

  it("leaves no partial file behind for a reader to mistake for a backup", async () => {
    await seedRepository("repo_GGGGGGGGGGGGGGGGGGGGGGGGGG");
    await runBackup(root, new DirectoryBackupStore(backupDir));
    const stored = await fs.promises.readdir(backupDir);
    expect(stored.some((f) => f.endsWith(".partial"))).toBe(false);
  });

  it("keeps going when one repository fails, and names it", async () => {
    await seedRepository("repo_HHHHHHHHHHHHHHHHHHHHHHHHHH");
    await makeCorruptRepository("repo_IIIIIIIIIIIIIIIIIIIIIIIIII");

    const report = await runBackup(root, new DirectoryBackupStore(backupDir));
    expect(report.bundled).toHaveLength(1);
    expect(report.failed.map((f) => f.repoId)).toContain("repo_IIIIIIIIIIIIIIIIIIIIIIIIII");
  });

  it("REPORTS A CORRUPT REPOSITORY AS FAILED, NEVER AS EMPTY", async () => {
    // Collapsing the two would drop a damaged book from the backup set while
    // the run still looked clean enough to prune by.
    await makeCorruptRepository("repo_ZZZZZZZZZZZZZZZZZZZZZZZZZZ");
    const report = await runBackup(root, new DirectoryBackupStore(backupDir));
    expect(report.failed.map((f) => f.repoId)).toEqual(["repo_ZZZZZZZZZZZZZZZZZZZZZZZZZZ"]);
    expect(report.skipped).toEqual([]);
    expect(report.failed[0]!.error).toMatch(/not a readable repository/);
  });

  it("still reports a genuinely empty repository as skipped", async () => {
    const gitdir = repoPath(root, "repo_YYYYYYYYYYYYYYYYYYYYYYYYYY");
    await initRepo(gitdir);
    const report = await runBackup(root, new DirectoryBackupStore(backupDir));
    expect(report.skipped).toEqual(["repo_YYYYYYYYYYYYYYYYYYYYYYYYYY"]);
    expect(report.failed).toEqual([]);
  });

  it("DOES NOT PRUNE after a run that partly failed", async () => {
    await seedRepository("repo_JJJJJJJJJJJJJJJJJJJJJJJJJJ");
    await makeCorruptRepository("repo_KKKKKKKKKKKKKKKKKKKKKKKKKK");
    const store = new DirectoryBackupStore(backupDir);

    // An old bundle from a previous run, well past the retention window.
    const stale = path.join(backupDir, "repo_OLD.bundle");
    await fs.promises.mkdir(backupDir, { recursive: true });
    await fs.promises.writeFile(stale, "old");
    const longAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000);
    await fs.promises.utimes(stale, longAgo, longAgo);

    const report = await runBackup(root, store, { keepDays: 30 });
    // One bad night must not turn into permanent loss.
    expect(report.failed.length).toBeGreaterThan(0);
    expect(report.pruned).toEqual([]);
    expect(fs.existsSync(stale)).toBe(true);
  });

  it("prunes stale bundles after a clean run", async () => {
    await seedRepository("repo_LLLLLLLLLLLLLLLLLLLLLLLLLL");
    const store = new DirectoryBackupStore(backupDir);
    await fs.promises.mkdir(backupDir, { recursive: true });
    const stale = path.join(backupDir, "repo_GONE.bundle");
    await fs.promises.writeFile(stale, "old");
    const longAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000);
    await fs.promises.utimes(stale, longAgo, longAgo);

    const report = await runBackup(root, store, { keepDays: 30 });
    expect(report.failed).toEqual([]);
    expect(report.pruned).toContain("repo_GONE.bundle");
    expect(fs.existsSync(stale)).toBe(false);
  });

  it("keeps a bundle that is still current, however old the file", async () => {
    const repoId = "repo_MMMMMMMMMMMMMMMMMMMMMMMMMM";
    await seedRepository(repoId);
    const store = new DirectoryBackupStore(backupDir);
    await runBackup(root, store, { keepDays: 30 });

    const current = path.join(backupDir, `${repoId}.bundle`);
    const longAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000);
    await fs.promises.utimes(current, longAgo, longAgo);

    await runBackup(root, store, { keepDays: 30 });
    expect(fs.existsSync(current)).toBe(true);
  });
});

describe("restore", () => {
  it("RESTORES A BOOK INTO AN EMPTY VOLUME WITH ITS HISTORY INTACT", async () => {
    const repoId = "repo_NNNNNNNNNNNNNNNNNNNNNNNNNN";
    const original = await seedRepository(repoId, 3);
    await runBackup(root, new DirectoryBackupStore(backupDir));

    const before = execFileSync("git", ["--git-dir", original, "log", "--format=%H %s"], {
      encoding: "utf8",
    });

    const restored = path.join(restoreDir, `${repoId}.git`);
    await restoreRepository(path.join(backupDir, `${repoId}.bundle`), restored);

    const after = execFileSync("git", ["--git-dir", restored, "log", "--format=%H %s"], {
      encoding: "utf8",
    });
    expect(after).toBe(before);
  });

  it("RESTORES THE RECEIPT CHAIN, AND IT STILL VERIFIES", async () => {
    // This is what makes a restore a restore. Recovering the prose but losing
    // the ability to verify it would return the manuscript without the thing
    // GitLit exists to provide.
    const repoId = "repo_OOOOOOOOOOOOOOOOOOOOOOOOOO";
    await seedRepository(repoId, 3);
    await runBackup(root, new DirectoryBackupStore(backupDir));

    const restored = path.join(restoreDir, `${repoId}.git`);
    await restoreRepository(path.join(backupDir, `${repoId}.bundle`), restored);

    const chainText = await readFileAt(restored, "refs/heads/main", ".gitlit/receipts/chain.jsonl");
    expect(chainText).toBeTruthy();

    const chain = receiptsFromJsonl(chainText!);
    expect(chain.length).toBeGreaterThanOrEqual(3);
    const result = verifyChain(chain, new Map([[key.keyId, key.publicKey]]));
    expect(result.valid).toBe(true);
    expect(result.verified).toBe(chain.length);
  });

  it("restores the prose in its canonical form", async () => {
    const repoId = "repo_PPPPPPPPPPPPPPPPPPPPPPPPPP";
    await seedRepository(repoId, 1);
    await runBackup(root, new DirectoryBackupStore(backupDir));

    const restored = path.join(restoreDir, `${repoId}.git`);
    await restoreRepository(path.join(backupDir, `${repoId}.bundle`), restored);

    const prose = await readFileAt(restored, "refs/heads/main", "manuscript/chapters/01.md");
    expect(prose).toBe("The lighthouse had been dark for 1 years.\nMara counted them.\n");
  });

  it("restores provenance sidecars alongside the prose", async () => {
    const repoId = "repo_QQQQQQQQQQQQQQQQQQQQQQQQQQ";
    await seedRepository(repoId, 1);
    await runBackup(root, new DirectoryBackupStore(backupDir));

    const restored = path.join(restoreDir, `${repoId}.git`);
    await restoreRepository(path.join(backupDir, `${repoId}.bundle`), restored);

    const sidecar = await readFileAt(
      restored, "refs/heads/main", ".gitlit/provenance/manuscript/chapters/01.md.jsonl",
    );
    expect(sidecar).toBeTruthy();
    expect(JSON.parse(sidecar!.trim()).origin).toBe("human_written");
  });

  it("refuses a corrupt bundle rather than producing an empty repository", async () => {
    const corrupt = path.join(backupDir, "corrupt.bundle");
    await fs.promises.mkdir(backupDir, { recursive: true });
    await fs.promises.writeFile(corrupt, "not a bundle");
    await expect(restoreRepository(corrupt, path.join(restoreDir, "x.git"))).rejects.toThrow();
  });

  it("leaves no dangling remote pointing at the bundle file", async () => {
    const repoId = "repo_RRRRRRRRRRRRRRRRRRRRRRRRRR";
    await seedRepository(repoId, 1);
    await runBackup(root, new DirectoryBackupStore(backupDir));
    const restored = path.join(restoreDir, `${repoId}.git`);
    await restoreRepository(path.join(backupDir, `${repoId}.bundle`), restored);

    const remotes = execFileSync("git", ["--git-dir", restored, "remote"], { encoding: "utf8" });
    expect(remotes.trim()).toBe("");
  });
});

// The rehearsal that found this: a restore recovered the manuscript and every
// receipt, and none of them could be verified, because the key lived only on
// the volume that was lost.
describe("a restored book can still be verified", () => {
  it("VERIFIES FROM THE REPOSITORY ALONE — no server, no database", async () => {
    const repoId = "repo_SSSSSSSSSSSSSSSSSSSSSSSSSS";
    await seedRepository(repoId, 3);
    await runBackup(root, new DirectoryBackupStore(backupDir));

    const restored = path.join(restoreDir, `${repoId}.git`);
    await restoreRepository(path.join(backupDir, `${repoId}.bundle`), restored);

    const result = await verifyRepository(restored);
    expect(result.reason).toBeUndefined();
    expect(result.receipts).toBeGreaterThanOrEqual(3);
    expect(result.valid).toBe(true);
    expect(result.verified).toBe(result.receipts);
  });

  it("carries the public key inside the history, so a clone can check it", async () => {
    const repoId = "repo_TTTTTTTTTTTTTTTTTTTTTTTTTT";
    const gitdir = await seedRepository(repoId, 1);
    const tracked = execFileSync("git", ["--git-dir", gitdir, "ls-tree", "-r", "--name-only", "HEAD"], {
      encoding: "utf8",
    });
    expect(tracked).toMatch(/\.gitlit\/keys\/.*\.pub/);
  });

  it("detects tampering in a restored chain rather than passing it", async () => {
    const repoId = "repo_UUUUUUUUUUUUUUUUUUUUUUUUUU";
    await seedRepository(repoId, 3);
    await runBackup(root, new DirectoryBackupStore(backupDir));
    const restored = path.join(restoreDir, `${repoId}.git`);
    await restoreRepository(path.join(backupDir, `${repoId}.bundle`), restored);

    // Drop a receipt from the middle, as someone hiding a commit would.
    const chain = (await readFileAt(restored, "refs/heads/main", ".gitlit/receipts/chain.jsonl"))!
      .split("\n").filter(Boolean);
    const tampered = [chain[0], chain[chain.length - 1]].join("\n") + "\n";
    const receipts = receiptsFromJsonl(tampered);
    const keyPem = (await readFileAt(
      restored, "refs/heads/main", `.gitlit/keys/${key.keyId}.pub`,
    ))!;
    expect(verifyChain(receipts, new Map([[key.keyId, keyPem]])).valid).toBe(false);
  });

  it("restores the signing key so the chain can be extended", async () => {
    const repoId = "repo_VVVVVVVVVVVVVVVVVVVVVVVVVV";
    await seedRepository(repoId, 1);
    await runBackup(root, new DirectoryBackupStore(backupDir));
    const restored = path.join(restoreDir, `${repoId}.git`);
    await restoreRepository(path.join(backupDir, `${repoId}.bundle`), restored);
    expect(fs.existsSync(path.join(restored, "gitlit-signing-key.json"))).toBe(true);
  });

  it("says why it cannot verify, rather than reporting a failure", async () => {
    const repoId = "repo_WWWWWWWWWWWWWWWWWWWWWWWWWW";
    const gitdir = repoPath(root, repoId);
    await initRepo(gitdir);
    const result = await verifyRepository(gitdir);
    expect(result.reason).toBe("no_receipts");
    expect(result.valid).toBe(false);
  });
});
