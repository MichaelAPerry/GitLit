/**
 * Preflight: the checks that only a running deployment can answer.
 *
 * Every failure listed in DEPLOY.md's "three failures that look like success"
 * shares one property — the service stays green while being broken. A test
 * suite cannot catch any of them, because none is a property of the code: they
 * are properties of a machine, a DNS record, a disk. This is the thing you run
 * against the real deployment to find out.
 */

export type Status = "pass" | "fail" | "warn" | "skip";

export interface CheckResult {
  id: string;
  title: string;
  status: Status;
  /** One line, written for the person reading it, not for a log. */
  detail: string;
  /** Why this check exists — what goes wrong, in plain terms. */
  why: string;
  /** What to do about a fail or warn. Omitted on a pass. */
  remedy?: string;
  /**
   * True when the answer requires a human to look at something we cannot see
   * — an inbox, an S3 bucket. Reported honestly rather than guessed at.
   */
  needsHuman?: boolean;
}

export interface Check {
  id: string;
  title: string;
  why: string;
  run(ctx: CheckContext): Promise<CheckResult>;
}

export interface CheckContext {
  /** Base URL of the api, e.g. https://api.gitlit.app */
  apiUrl: string;
  /** Base URL of gitd, if reachable. Often internal-only; checks skip if absent. */
  gitdUrl?: string | undefined;
  /** Base URL of the web app, e.g. https://gitlit.app */
  webUrl?: string | undefined;
  /** Operator token for the internal checks. Without it those are skipped. */
  operatorToken?: string | undefined;
  /** An address the operator owns, for the one check that needs a real inbox. */
  email?: string | undefined;
  fetch: typeof globalThis.fetch;
}

export interface Report {
  startedAt: string;
  target: string;
  results: CheckResult[];
}

export const pass = (c: Check, detail: string): CheckResult =>
  ({ id: c.id, title: c.title, why: c.why, status: "pass", detail });

export const fail = (c: Check, detail: string, remedy: string): CheckResult =>
  ({ id: c.id, title: c.title, why: c.why, status: "fail", detail, remedy });

export const warn = (c: Check, detail: string, remedy: string): CheckResult =>
  ({ id: c.id, title: c.title, why: c.why, status: "warn", detail, remedy });

export const skip = (c: Check, detail: string): CheckResult =>
  ({ id: c.id, title: c.title, why: c.why, status: "skip", detail });

/** Counts by status, for the summary line and the exit code. */
export function tally(results: CheckResult[]): Record<Status, number> {
  const t: Record<Status, number> = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const r of results) t[r.status] += 1;
  return t;
}
