import fs from "node:fs";
import path from "node:path";
import git from "isomorphic-git";
import { normalizePath } from "@gitlit/core";

export interface RepoRef { gitdir: string }

/** Sharded storage path, so one directory never holds a million repos. */
export function repoPath(root: string, repoId: string): string {
  const a = repoId.slice(-4, -2) || "00";
  const b = repoId.slice(-2) || "00";
  return path.join(root, a, b, `${repoId}.git`);
}

export async function initRepo(gitdir: string, defaultBranch = "main"): Promise<void> {
  await fs.promises.mkdir(gitdir, { recursive: true });
  await git.init({ fs, bare: true, gitdir, defaultBranch });
}

export async function resolveHead(gitdir: string, ref: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs, gitdir, ref });
  } catch {
    return null;
  }
}

export interface Entry { path: string; oid: string; mode: string }

/** Flatten a commit's tree to path -> blob. Manuscript repos are small. */
export async function listTree(gitdir: string, oid: string): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>();
  const walk = async (treeOid: string, prefix: string): Promise<void> => {
    const { tree } = await git.readTree({ fs, gitdir, oid: treeOid });
    for (const entry of tree) {
      const full = prefix ? `${prefix}/${entry.path}` : entry.path;
      if (entry.type === "tree") await walk(entry.oid, full);
      else out.set(full, { path: full, oid: entry.oid, mode: entry.mode });
    }
  };
  const { commit } = await git.readCommit({ fs, gitdir, oid });
  await walk(commit.tree, "");
  return out;
}

export async function readFileAt(
  gitdir: string, ref: string, filepath: string,
): Promise<string | null> {
  const oid = await resolveHead(gitdir, ref);
  if (!oid) return null;
  try {
    const { blob } = await git.readBlob({ fs, gitdir, oid, filepath: normalizePath(filepath) });
    return new TextDecoder().decode(blob);
  } catch {
    return null;
  }
}

/** Rebuild nested trees from a flat path map and return the root tree oid. */
async function writeTreeFromEntries(gitdir: string, entries: Map<string, Entry>): Promise<string> {
  interface Node { dirs: Map<string, Node>; files: Map<string, Entry> }
  const root: Node = { dirs: new Map(), files: new Map() };

  for (const entry of entries.values()) {
    const parts = entry.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      if (!node.dirs.has(seg)) node.dirs.set(seg, { dirs: new Map(), files: new Map() });
      node = node.dirs.get(seg)!;
    }
    node.files.set(parts[parts.length - 1]!, entry);
  }

  const write = async (node: Node): Promise<string> => {
    const tree: { mode: string; path: string; oid: string; type: "blob" | "tree" }[] = [];
    for (const [name, child] of node.dirs) {
      tree.push({ mode: "040000", path: name, oid: await write(child), type: "tree" });
    }
    for (const [name, entry] of node.files) {
      tree.push({ mode: entry.mode, path: name, oid: entry.oid, type: "blob" });
    }
    tree.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return git.writeTree({ fs, gitdir, tree });
  };
  return write(root);
}

export interface FileChange { path: string; content: string | null }

export interface CommitInput {
  gitdir: string;
  ref: string;
  changes: FileChange[];
  message: string;
  author: { name: string; email: string };
  timestamp?: number;
}

/** Apply changes and write a commit. Deleting is `content: null`. */
export async function commitChanges(input: CommitInput): Promise<string> {
  const { gitdir, ref, changes, message, author } = input;
  const parent = await resolveHead(gitdir, ref);
  const entries = parent ? await listTree(gitdir, parent) : new Map<string, Entry>();

  for (const change of changes) {
    const p = normalizePath(change.path);
    if (change.content === null) {
      entries.delete(p);
      continue;
    }
    const oid = await git.writeBlob({ fs, gitdir, blob: new TextEncoder().encode(change.content) });
    entries.set(p, { path: p, oid, mode: "100644" });
  }

  const tree = await writeTreeFromEntries(gitdir, entries);
  const when = input.timestamp ?? Math.floor(Date.now() / 1000);
  const sig = { name: author.name, email: author.email, timestamp: when, timezoneOffset: 0 };

  const sha = await git.writeCommit({
    fs, gitdir,
    commit: { message, tree, parent: parent ? [parent] : [], author: sig, committer: sig },
  });
  await git.writeRef({ fs, gitdir, ref, value: sha, force: true });
  return sha;
}

export async function log(gitdir: string, ref: string, depth = 50) {
  const oid = await resolveHead(gitdir, ref);
  if (!oid) return [];
  return git.log({ fs, gitdir, ref, depth });
}
