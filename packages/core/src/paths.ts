import { invalid } from "./errors.js";

export const MANUSCRIPT_DIR = "manuscript/";
export const GITLIT_DIR = ".gitlit/";
export const ARCHITECTURE_FILE = "manuscript_architecture.md";

/**
 * Paths an MCP agent may write (§8.3). Deliberately excludes manuscript/ —
 * this is how "the AI never writes prose" is enforced in code rather than policy.
 */
export function assertAgentWritable(path: string): void {
  const p = normalizePath(path);
  const ok = p === ARCHITECTURE_FILE || p.startsWith(GITLIT_DIR);
  if (!ok) {
    throw invalid(
      `Agents may write only ${ARCHITECTURE_FILE} and ${GITLIT_DIR}** — refused "${p}".`,
      { reject_reason: "path_outside_allowlist" },
    );
  }
}

export function isProseFile(path: string): boolean {
  const p = normalizePath(path);
  return p.startsWith(MANUSCRIPT_DIR) && p.endsWith(".md");
}

/** Rejects traversal, absolute paths and backslashes before anything touches disk. */
export function normalizePath(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (p.startsWith("/") || p.split("/").includes("..") || p.includes("\0")) {
    throw invalid(`Illegal path: "${path}"`, { reject_reason: "illegal_path" });
  }
  return p;
}
