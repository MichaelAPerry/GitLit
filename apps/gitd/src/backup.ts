import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import os from "node:os";

const run = promisify(execFile);

/**
 * Manuscript backup (§4.1).
 *
 * `gitd`'s volume holds the only copy of every book. For a product whose
 * promise is that an author's history is safe here, a single disk is not a
 * story — so every repository is bundled, verified, and copied somewhere else.
 *
 * `git bundle` rather than a filesystem copy: a bundle is a single
 * self-contained file, and `git bundle verify` proves it can actually restore
 * before we throw anything away. A tar of a live repository can be taken
 * mid-write and nobody finds out until the day it is needed.
 */

export interface BackupStore {
  /** Where this store writes, for logs and the manifest. */
  readonly location: string;
  put(name: string, source: string): Promise<void>;
  list(): Promise<{ name: string; size: number; modified: Date }[]>;
  remove(name: string): Promise<void>;
}

/**
 * Backup to a directory.
 *
 * Deliberately the only store implemented. A directory is what a mounted
 * volume, an NFS share, or an rsync/rclone target all look like, so offsite
 * copying is one `aws s3 sync` away and stays the operator's choice — rather
 * than this repository carrying cloud credentials and an S3 client that has
 * never been run against a real bucket.
 */
export class DirectoryBackupStore implements BackupStore {
  constructor(readonly location: string) {}

  async put(name: string, source: string): Promise<void> {
    await fs.promises.mkdir(this.location, { recursive: true });
    const target = path.join(this.location, name);
    // Write beside the target then rename: a reader must never see a
    // half-copied bundle and take it for a backup.
    const staging = `${target}.partial`;
    await fs.promises.copyFile(source, staging);
    await fs.promises.rename(staging, target);
  }

  async list(): Promise<{ name: string; size: number; modified: Date }[]> {
    if (!fs.existsSync(this.location)) return [];
    const names = await fs.promises.readdir(this.location);
    const entries = await Promise.all(
      names.filter((n) => n.endsWith(".bundle")).map(async (name) => {
        const stat = await fs.promises.stat(path.join(this.location, name));
        return { name, size: stat.size, modified: stat.mtime };
      }),
    );
    return entries.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  }

  async remove(name: string): Promise<void> {
    await fs.promises.rm(path.join(this.location, name), { force: true });
  }
}

/** Every bare repository under the sharded storage root. */
export async function discoverRepositories(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4 || !fs.existsSync(dir)) return;
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name.endsWith(".git")) found.push(full);
      else await walk(full, depth + 1);
    }
  };
  await walk(root, 0);
  return found.sort();
}

export const repoIdFromPath = (gitdir: string): string =>
  path.basename(gitdir).replace(/\.git$/, "");

export interface BundleResult {
  repoId: string;
  bundleName: string;
  bytes: number;
  sha256: string;
  refs: number;
  /** Whether the signing key was captured alongside the history. */
  signingKeyBacked: boolean;
}

/**
 * The private signing key is a loose file in the gitdir, so `git bundle`
 * does not carry it. Losing it does not make existing receipts unverifiable
 * — the public key is committed into the repository (§7.4) — but it does
 * stop the chain being extended, which would strand a restored book at the
 * point of the backup.
 *
 * It is stored wrapped when SIGNING_MASTER_KEY is set. When it is not, the
 * key is on disk in the clear and copying it merely moves that exposure;
 * the warning belongs in the deployment notes, not in a silent skip.
 */
const SIGNING_KEY_FILE = "gitlit-signing-key.json";

/**
 * Bundle one repository and prove the bundle is restorable.
 *
 * An empty repository has no refs and `git bundle` refuses it; that is not a
 * failure worth alarming anyone about, so it is reported as skipped.
 */
export async function bundleRepository(
  gitdir: string, destination: string,
): Promise<BundleResult | null> {
  const repoId = repoIdFromPath(gitdir);

  /**
   * Establish the repository is READABLE before asking about its refs.
   *
   * `git show-ref` exits non-zero both for a genuinely empty repository and
   * for a corrupt one. Collapsing those would report a damaged book as an
   * empty new one — it would be quietly dropped from the backup set, and the
   * run would still look clean enough to prune by.
   */
  try {
    await run("git", ["--git-dir", gitdir, "rev-parse", "--git-dir"]);
  } catch (error) {
    throw new Error(
      `${repoId} is not a readable repository: ` +
      `${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
  }

  const { stdout: refOutput } = await run("git", ["--git-dir", gitdir, "show-ref"]).catch(
    () => ({ stdout: "" }),
  );
  const refs = refOutput.split("\n").filter(Boolean).length;
  if (refs === 0) return null;

  const bundlePath = path.join(destination, `${repoId}.bundle`);
  await fs.promises.mkdir(destination, { recursive: true });
  // --all covers every branch and tag, which includes .gitlit/ receipts and
  // provenance sidecars — those are the point of keeping the history at all.
  await run("git", ["--git-dir", gitdir, "bundle", "create", bundlePath, "--all"]);

  /**
   * A bundle that cannot restore is not a backup. Fail loudly here rather
   * than discover it on the day it matters.
   *
   * `--git-dir` is required: `git bundle verify` resolves the bundle's
   * prerequisite commits against a repository, and with no repository in
   * scope it exits with "need a repository to verify a bundle". That depends
   * on the process's working directory, so it passed in a test run from
   * inside the repo and failed for EVERY repository in the container, where
   * the working directory is /app. Backups were not being taken at all.
   */
  await run("git", ["--git-dir", gitdir, "bundle", "verify", bundlePath]);

  // Capture the signing key beside the bundle so a restored repository can
  // keep issuing receipts rather than starting a new, orphaned chain.
  const keySource = path.join(gitdir, SIGNING_KEY_FILE);
  let signingKeyBacked = false;
  if (fs.existsSync(keySource)) {
    await fs.promises.copyFile(keySource, path.join(destination, `${repoId}.key.json`));
    signingKeyBacked = true;
  }

  const bytes = await fs.promises.readFile(bundlePath);
  return {
    repoId,
    bundleName: path.basename(bundlePath),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    refs,
    signingKeyBacked,
  };
}

export interface BackupReport {
  startedAt: string;
  finishedAt: string;
  location: string;
  bundled: BundleResult[];
  skipped: string[];
  failed: { repoId: string; error: string }[];
  pruned: string[];
}

export interface BackupOptions {
  /** Bundles older than this are removed after a successful run. */
  keepDays?: number;
  /** Scratch space for bundles before they are stored. */
  workDir?: string;
}

/**
 * Bundle every repository and copy the results to the store.
 *
 * One repository failing does not abandon the run — the remaining books still
 * deserve a backup, and the report names what failed so it is visible rather
 * than silently absent next time.
 */
export async function runBackup(
  root: string, store: BackupStore, options: BackupOptions = {},
): Promise<BackupReport> {
  const startedAt = new Date().toISOString();
  const workDir = options.workDir
    ?? await fs.promises.mkdtemp(path.join(os.tmpdir(), "gitlit-backup-"));

  const bundled: BundleResult[] = [];
  const skipped: string[] = [];
  const failed: { repoId: string; error: string }[] = [];

  for (const gitdir of await discoverRepositories(root)) {
    const repoId = repoIdFromPath(gitdir);
    try {
      const result = await bundleRepository(gitdir, workDir);
      if (!result) { skipped.push(repoId); continue; }
      await store.put(result.bundleName, path.join(workDir, result.bundleName));
      if (result.signingKeyBacked) {
        await store.put(`${repoId}.key.json`, path.join(workDir, `${repoId}.key.json`));
      }
      bundled.push(result);
    } catch (error) {
      failed.push({ repoId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const manifest = {
    startedAt,
    finishedAt: new Date().toISOString(),
    location: store.location,
    bundled,
    skipped,
    failed,
  };
  const manifestPath = path.join(workDir, "manifest.json");
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await store.put(`manifest-${startedAt.replace(/[:.]/g, "-")}.json`, manifestPath);

  /**
   * Prune only after a clean run. Deleting old backups on the strength of a
   * run that partly failed is how one bad night becomes permanent loss.
   */
  const pruned: string[] = [];
  if (options.keepDays && failed.length === 0) {
    const cutoff = Date.now() - options.keepDays * 24 * 60 * 60 * 1000;
    const current = new Set(bundled.map((b) => b.bundleName));
    for (const entry of await store.list()) {
      if (current.has(entry.name)) continue;
      if (entry.modified.getTime() < cutoff) {
        await store.remove(entry.name);
        pruned.push(entry.name);
      }
    }
  }

  if (!options.workDir) await fs.promises.rm(workDir, { recursive: true, force: true });
  return { ...manifest, pruned };
}

/**
 * Restore a repository from a bundle.
 *
 * The inverse of the above, and the half that is usually never exercised —
 * which is why it lives in the same module and is covered by the same tests.
 * A backup nobody has restored is a hypothesis.
 */
export async function restoreRepository(bundlePath: string, gitdir: string): Promise<void> {
  await run("git", ["bundle", "verify", bundlePath]);
  await fs.promises.mkdir(path.dirname(gitdir), { recursive: true });
  await run("git", ["clone", "--bare", bundlePath, gitdir]);

  // Put the signing key back if it was captured, so the chain can continue.
  const keyBackup = bundlePath.replace(/\.bundle$/, ".key.json");
  if (fs.existsSync(keyBackup)) {
    await fs.promises.copyFile(keyBackup, path.join(gitdir, SIGNING_KEY_FILE));
    await fs.promises.chmod(path.join(gitdir, SIGNING_KEY_FILE), 0o600);
  }
  // A clone from a bundle records the bundle file as its origin, which will
  // not exist on the restored host.
  await run("git", ["--git-dir", gitdir, "remote", "remove", "origin"]).catch(() => undefined);
}
