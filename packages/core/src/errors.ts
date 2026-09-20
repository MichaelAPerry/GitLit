import { timingSafeEqual } from "node:crypto";
/** RFC 9457 problem details. Every API error serializes through this. */
export class GitLitError extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    readonly title: string,
    override readonly message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GitLitError";
  }

  toProblem() {
    return {
      type: `https://gitlit.app/errors/${this.type}`,
      title: this.title,
      status: this.status,
      detail: this.message,
      ...(this.detail ?? {}),
    };
  }
}

export const notFound = (what: string) =>
  new GitLitError("not-found", 404, "Not found", `${what} not found`);

export const forbidden = (why: string) =>
  new GitLitError("forbidden", 403, "Forbidden", why);

export const invalid = (why: string, detail?: Record<string, unknown>) =>
  new GitLitError("invalid-request", 400, "Invalid request", why, detail);

export const conflict = (why: string) =>
  new GitLitError("conflict", 409, "Conflict", why);

/**
 * Raised when an agent tool call is refused by a guardrail (§8.3).
 * These are recorded to agent_tool_calls with status 'rejected' — a refused
 * call is evidence, not an error to swallow.
 */
export const toolRejected = (reason: string, why: string) =>
  new GitLitError("tool-rejected", 422, "Tool call rejected", why, { reject_reason: reason });

/**
 * Compare two secrets without leaking which one is longer, or where they
 * first differ, through how long the comparison takes.
 *
 * A mismatched length still runs a real comparison rather than returning
 * early: an early return is itself a measurable signal about the secret.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
