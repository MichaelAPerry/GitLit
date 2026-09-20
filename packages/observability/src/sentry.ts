import * as Sentry from "@sentry/node";
import { scrubUrl, scrubValue } from "./scrub.js";

export interface MonitoringEnv {
  SENTRY_DSN?: string | undefined;
  NODE_ENV?: string | undefined;
  GIT_SHA?: string | undefined;
  FLY_MACHINE_ID?: string | undefined;
}

export interface MonitoringOptions {
  /** "api" | "gitd" | "mcp" — which service this is, for grouping. */
  service: string;
  env?: MonitoringEnv;
}

/**
 * Error monitoring (§4 names Sentry).
 *
 * No DSN means no monitoring and no complaint: local development and the test
 * suite must not depend on a third party being reachable, and a stack that
 * refuses to run without an error tracker has made the tracker a dependency of
 * the product.
 *
 * Everything sent is scrubbed first (`scrub.ts`). That is not a courtesy — an
 * error tracker is a pipe to someone else's servers that runs on the unhappy
 * path, where payloads are biggest and least expected, and the payloads here
 * are manuscripts and sign-in links.
 */
export function initMonitoring({ service, env = process.env }: MonitoringOptions): boolean {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return false;

  Sentry.init({
    dsn,
    environment: env.NODE_ENV ?? "development",
    release: env.GIT_SHA,
    // Never let the SDK decide what counts as personal. Everything it would
    // attach on its own — ip addresses, headers, cookies, request bodies —
    // stays off, and what we do send goes through beforeSend below.
    sendDefaultPii: false,
    /**
     * Local variables are never attached to a stack frame.
     *
     * A frame in the commit path has the chapter in scope. Turning this on
     * would put manuscripts in a third-party error tracker one stack trace at
     * a time. It is off by default in the Node SDK; it is set here so that
     * remains a decision rather than a default someone can flip.
     */
    includeLocalVariables: false,
    /**
     * No source context either — and this one is NOT the default.
     *
     * The SDK reads the deployed source file around every stack frame and
     * ships `pre_context` / `context_line` / `post_context` with the event. A
     * deploy rehearsal caught it: text that appears near a throw leaves the
     * process whether or not anyone modelled that field. Scrubbing cannot
     * help, because source is not shaped like a secret — the fix is not to
     * send it. Filename, line and function still come through, which is what
     * a stack trace is for.
     */
    integrations: (defaults) => defaults.filter((i) => i.name !== "ContextLines"),
    // Traces are a separate decision with a separate cost; off until someone
    // turns them on deliberately.
    tracesSampleRate: 0,
    initialScope: { tags: { service, machine: env.FLY_MACHINE_ID ?? "local" } },
    beforeSend(event) {
      try {
        if (event.request?.url) event.request.url = scrubUrl(event.request.url);
        // Dropped entirely rather than scrubbed: neither is ever worth the
        // risk of one missed pattern.
        delete event.request?.cookies;
        delete event.request?.data;
        delete event.user;
        return scrubValue(event);
      } catch {
        // A scrubber that throws must not send the unscrubbed event.
        return null;
      }
    },
    beforeBreadcrumb(crumb) {
      try {
        return scrubValue(crumb);
      } catch {
        return null;
      }
    },
  });
  return true;
}

/**
 * Report an exception. A no-op when monitoring is off, so callers never guard.
 *
 * `expected` marks faults that are the client's, not ours: a 4xx is a normal
 * outcome, and reporting it trains everyone to ignore the alerts that matter.
 */
export function reportError(err: unknown, context?: Record<string, unknown>): void {
  if (!Sentry.isInitialized()) return;
  Sentry.captureException(err, context ? { extra: scrubValue(context) } : undefined);
}

export function flushMonitoring(timeoutMs = 2000): Promise<boolean> {
  if (!Sentry.isInitialized()) return Promise.resolve(true);
  return Sentry.flush(timeoutMs);
}

export { Sentry };
