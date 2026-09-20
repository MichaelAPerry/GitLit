import type { FastifyInstance, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";

/**
 * Rate limiting (§2.5).
 *
 * Two limits, because they defend against different things:
 *
 *   per IP      — a script hammering the API from one place.
 *   per address — a botnet asking for sign-in links to ONE victim's inbox.
 *                 Each request comes from a different IP, so the per-IP limit
 *                 never fires, and the victim is mail-bombed with links they
 *                 did not ask for, on GitLit's sending reputation.
 *
 * The second is the one an IP limit cannot cover, and it is the reason the
 * magic-link route has a limit of its own.
 */

/** Requests per window, per IP, for everything that is not called out below. */
const GLOBAL_MAX = 300;
const GLOBAL_WINDOW = "1 minute";

/** Sign-in and token minting: expensive, abusable, and rarely repeated. */
export const AUTH_MAX = 10;
export const AUTH_WINDOW_MS = 60_000;

/** Per email address. Deliberately below the per-IP limit. */
export const ADDRESS_MAX = 3;
export const ADDRESS_WINDOW_MS = 15 * 60_000;

/**
 * Paths that must never be limited.
 *
 * `/health` is polled by the platform every few seconds; limiting it takes the
 * service out of rotation. `/v1/internal/git-access` is called by gitd once
 * per Git transport request, all from gitd's single internal address — a limit
 * there does not slow an attacker down, it breaks `git clone` for everyone.
 */
const EXEMPT = new Set(["/health", "/v1/internal/git-access"]);

/**
 * A fixed-window counter keyed by something that is not an IP.
 *
 * Deliberately small: it prunes on write, so a flood of distinct addresses
 * cannot grow it without bound — an in-memory limiter that leaks is a denial
 * of service wearing the costume of a defence.
 */
export class KeyedLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when the caller is within its allowance; false when it is over. */
  take(key: string): boolean {
    const t = this.now();
    this.prune(t);
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.max;
  }

  /** Seconds until this key is allowed again; 0 when it already is. */
  retryAfter(key: string): number {
    const entry = this.hits.get(key);
    if (!entry) return 0;
    return Math.max(0, Math.ceil((entry.resetAt - this.now()) / 1000));
  }

  private prune(t: number): void {
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= t) this.hits.delete(key);
    }
  }

  get size(): number { return this.hits.size; }

  clear(): void { this.hits.clear(); }
}

export const addressLimiter = new KeyedLimiter(ADDRESS_MAX, ADDRESS_WINDOW_MS);

/**
 * The tighter per-IP limit for sign-in and token routes.
 *
 * Kept here rather than as a route option on @fastify/rate-limit so that both
 * auth limits are one mechanism with one shape: the plugin stays responsible
 * for the coarse platform-wide ceiling, and the two limits that actually
 * defend sign-in are ours, inspectable and resettable.
 */
export const ipLimiter = new KeyedLimiter(AUTH_MAX, AUTH_WINDOW_MS);

/** Clears both limiters. Tests only — nothing in the running server calls it. */
export function resetRateLimits(): void {
  addressLimiter.clear();
  ipLimiter.clear();
}

/** 429 body, identical in shape wherever a limit is hit. */
export function limitedResponse(retryAfter: number, detail: string) {
  return {
    type: "https://gitlit.app/errors/rate-limited",
    title: "Too many requests",
    status: 429,
    detail: `${detail} Try again in ${retryAfter}s.`,
  };
}

export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    max: GLOBAL_MAX,
    timeWindow: GLOBAL_WINDOW,
    // In-process, per machine. With N machines the effective limit is N times
    // this, which is acceptable for a coarse per-IP ceiling and NOT acceptable
    // for the auth limits — see the note in README's "Rate limiting".
    allowList: (req: FastifyRequest) => EXEMPT.has(req.url.split("?")[0] ?? req.url),
    keyGenerator: (req: FastifyRequest) => req.ip,
    errorResponseBuilder: (_req, ctx) => ({
      type: "https://gitlit.app/errors/rate-limited",
      title: "Too many requests",
      status: 429,
      detail: `Too many requests. Try again in ${Math.ceil(ctx.ttl / 1000)}s.`,
    }),
  });
}

/**
 * Guard for the sign-in and token routes: per IP, before anything expensive.
 * Returns the seconds to wait when the caller is over, or null when it is not.
 */
export function overAuthLimit(req: FastifyRequest): number | null {
  if (ipLimiter.take(req.ip)) return null;
  return ipLimiter.retryAfter(req.ip) || Math.ceil(AUTH_WINDOW_MS / 1000);
}
