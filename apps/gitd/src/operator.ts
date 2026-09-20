import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DirectoryBackupStore, discoverRepositories } from "./backup.js";

const run = promisify(execFile);

/**
 * gitd's operator surface, read by `gitlit-preflight`.
 *
 * gitd is the only process that can answer the questions that matter most —
 * whether the signing keys are encrypted on the volume, and whether the
 * newest backup would actually restore. Everything else is guesswork from
 * outside.
 *
 * Booleans and counts only. Never a key, never a path inside a manuscript.
 */

export interface GitdState {
  machine: string;
  /** How many signing keys exist on the volume, and how many are NOT encrypted. */
  keysOnDisk: number;
  unwrappedKeys: number;
  masterKeySet: boolean;
  repositories: number;
  backups: {
    count: number;
    newestAgeHours: number | null;
    newestVerifies: boolean | null;
    directory: string;
  };
}

const KEY_FILE = "gitlit-signing-key.json";

/**
 * Count the signing keys, and how many are readable.
 *
 * Counts rather than a boolean, because "none are unencrypted" and "there are
 * none yet" are different answers and a check that conflates them cries wolf
 * on every fresh deployment. An unreadable file counts as unwrapped: if we
 * cannot tell, we must not report it as safe.
 */
function countKeys(gitdirs: string[]): { keysOnDisk: number; unwrappedKeys: number } {
  let keysOnDisk = 0;
  let unwrappedKeys = 0;
  for (const dir of gitdirs) {
    const file = path.join(dir, KEY_FILE);
    if (!fs.existsSync(file)) continue;
    keysOnDisk += 1;
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { wrapped?: boolean };
      if (!stored.wrapped) unwrappedKeys += 1;
    } catch {
      unwrappedKeys += 1;
    }
  }
  return { keysOnDisk, unwrappedKeys };
}

/**
 * Open the newest bundle and check git can read it.
 *
 * `git bundle verify` walks the pack and checks the prerequisites, so this is
 * the difference between "a file exists" and "a backup exists". It is the
 * "restore one and look" step from DEPLOY.md, done every time preflight runs.
 */
async function newestVerifies(location: string, name: string, anyGitdir: string | undefined): Promise<boolean> {
  // Needs a repository in scope to resolve the bundle's prerequisites; any
  // repository will do for a structural check. Without one git refuses with
  // "need a repository to verify a bundle", regardless of the bundle.
  if (!anyGitdir) return false;
  try {
    await run("git", ["--git-dir", anyGitdir, "bundle", "verify", path.join(location, name)],
      { timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

export async function gitdState(repoRoot: string): Promise<GitdState> {
  const gitdirs = await discoverRepositories(repoRoot).catch(() => []);
  const backupDir = process.env.BACKUP_DIR ?? path.join(repoRoot, "..", "backups");

  let count = 0;
  let newestAgeHours: number | null = null;
  let verifies: boolean | null = null;

  try {
    const entries = await new DirectoryBackupStore(backupDir).list();
    count = entries.length;
    if (entries.length > 0) {
      const newest = entries.reduce((a, b) => (a.modified > b.modified ? a : b));
      newestAgeHours = (Date.now() - newest.modified.getTime()) / 3_600_000;
      verifies = await newestVerifies(backupDir, newest.name, gitdirs[0]);
    }
  } catch {
    // A missing backup directory is a finding, not an error: count stays 0 and
    // the check above reports "no backups found" with what to do about it.
  }

  return {
    machine: process.env.FLY_MACHINE_ID ?? process.env.HOSTNAME ?? "local",
    masterKeySet: Boolean(process.env.SIGNING_MASTER_KEY),
    ...countKeys(gitdirs),
    repositories: gitdirs.length,
    backups: { count, newestAgeHours, newestVerifies: verifies, directory: backupDir },
  };
}
