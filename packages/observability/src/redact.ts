import { Writable } from "node:stream";
import { scrubString as scrubByShape } from "./scrub.js";

/**
 * Keep operator secrets out of the logs, whatever path an error takes there.
 *
 * The scrubber in scrub.ts catches things by SHAPE — GitLit credentials, auth
 * headers, addresses. But an operator's secrets have no shape: a
 * GOOGLE_CLIENT_SECRET or a Postgres password is just an opaque string, and a
 * connection error can carry the whole DATABASE_URL, password and all, into
 * the log stream — which on a deployed box is a third-party log store that
 * many people can read.
 *
 * So this captures the actual secret VALUES from the environment at startup
 * and redacts any string that contains one, by identity rather than pattern.
 * If the value is in the log line, it is removed, whatever wrote it there.
 */

/** Env vars whose values must never appear in a log. */
export const SECRET_ENV_KEYS = [
  "DATABASE_URL",
  "GITD_SERVICE_TOKEN",
  "SIGNING_MASTER_KEY",
  "OPERATOR_TOKEN",
  "RESEND_API_KEY",
  "GITHUB_CLIENT_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "AUTH_SECRET",
  "SENTRY_DSN",
] as const;

const REDACTED = "[secret]";

/** A password embedded in a connection URL: postgres://user:PASSWORD@host. */
const DSN_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;

/**
 * Build a string scrubber bound to the current environment's secret values.
 *
 * Redacts, in one pass over a line of text:
 *   - the literal value of every operator secret (by identity, any shape);
 *   - a password embedded in a connection URL;
 *   - and the shape-based patterns (GitLit credentials, auth headers, emails).
 */
export function createLogScrubber(env: NodeJS.ProcessEnv = process.env): (line: string) => string {
  const values = SECRET_ENV_KEYS
    .map((k) => env[k]?.trim())
    .filter((v): v is string => typeof v === "string" && v.length >= 6)
    .sort((a, b) => b.length - a.length);

  return (line: string): string => {
    let out = line;
    for (const secret of values) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    out = out.replace(DSN_PASSWORD, `$1${REDACTED}@`);
    return scrubByShape(out);
  };
}

/**
 * Wrap a log destination so EVERY serialized line is scrubbed before it is
 * written — message, error stack, structured fields, all of it.
 *
 * This is deliberately at the stream, not a pino `formatters.log` hook: that
 * hook is handed only the structured fields, never the message string, so a
 * secret in an Error message (a Postgres DSN in a connection error is the
 * classic) would pass straight through it. Found by feeding a real Fastify
 * logger a DSN and watching the password appear in the output. Scrubbing the
 * finished line cannot be bypassed by where the secret happened to sit.
 */
export function secretScrubbingStream(
  destination: NodeJS.WritableStream = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): Writable {
  const scrub = createLogScrubber(env);
  return new Writable({
    write(chunk, _enc, cb) {
      try {
        destination.write(scrub(chunk.toString()));
      } catch {
        // Never let a scrubbing error swallow the log or crash the process;
        // an unscrubbed line is worse than losing this one, so drop it.
      }
      cb();
    },
  });
}
