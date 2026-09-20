import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { receiptsFromJsonl, verifyChain, type ChainResult } from "@gitlit/provenance";

const run = promisify(execFile);

/**
 * Verify a repository's receipt chain using ONLY what the repository contains
 * (§7.4).
 *
 * No database, no network, no GitLit server — that is the entire point. If
 * this function needs anything the clone does not carry, the offline promise
 * is not real, and a publisher checking a manuscript in five years has
 * nothing to check it with.
 */
export interface RepositoryVerification extends ChainResult {
  receipts: number;
  keys: string[];
  /** Set when the chain cannot be checked at all, rather than failing. */
  reason?: "no_receipts" | "no_keys";
}

async function show(gitdir: string, ref: string, filepath: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["--git-dir", gitdir, "show", `${ref}:${filepath}`], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

async function listKeyFiles(gitdir: string, ref: string): Promise<string[]> {
  try {
    const { stdout } = await run("git", [
      "--git-dir", gitdir, "ls-tree", "-r", "--name-only", ref, ".gitlit/keys/",
    ]);
    return stdout.split("\n").filter((line) => line.endsWith(".pub"));
  } catch {
    return [];
  }
}

export async function verifyRepository(
  gitdir: string, ref = "refs/heads/main",
): Promise<RepositoryVerification> {
  const chainText = await show(gitdir, ref, ".gitlit/receipts/chain.jsonl");
  if (!chainText?.trim()) {
    return { valid: false, verified: 0, failures: [], receipts: 0, keys: [], reason: "no_receipts" };
  }

  const receipts = receiptsFromJsonl(chainText);
  const keyFiles = await listKeyFiles(gitdir, ref);
  const keys = new Map<string, string>();
  for (const file of keyFiles) {
    const pem = await show(gitdir, ref, file);
    if (pem) keys.set(path.basename(file, ".pub"), pem);
  }

  if (keys.size === 0) {
    return {
      valid: false, verified: 0, failures: [], receipts: receipts.length,
      keys: [], reason: "no_keys",
    };
  }

  return { ...verifyChain(receipts, keys), receipts: receipts.length, keys: [...keys.keys()] };
}

/** True when a directory looks like a repository we can verify. */
export const isRepository = (gitdir: string): boolean =>
  fs.existsSync(path.join(gitdir, "HEAD"));
