/**
 * Which origins may call this API, and whether they may do so as the signed-in
 * author.
 *
 * These two questions are one decision. The web app sends every request with
 * `credentials: "include"`, so the API must answer
 * `Access-Control-Allow-Credentials: true` or the browser discards the
 * response — the dashboard simply does not load. But the moment credentials
 * are allowed, reflecting whatever Origin asked becomes an account-takeover
 * primitive: any page an author visits could call this API as them, with their
 * cookie, and read their manuscripts.
 *
 * So credentials are on and the origin is an allowlist. Getting one right and
 * not the other is worse than getting both wrong.
 */

export interface CorsEnv {
  NODE_ENV?: string | undefined;
  PUBLIC_WEB_URL?: string | undefined;
  /** Comma-separated extras: a staging domain, a preview deploy. */
  EXTRA_CORS_ORIGINS?: string | undefined;
}

const normalize = (origin: string) => origin.trim().replace(/\/+$/, "").toLowerCase();

export function allowedOrigins(env: CorsEnv = process.env): string[] {
  const list = [env.PUBLIC_WEB_URL, ...(env.EXTRA_CORS_ORIGINS?.split(",") ?? [])]
    .filter((o): o is string => Boolean(o?.trim()))
    .map(normalize);
  return [...new Set(list)];
}

export type OriginDecision = (origin: string | undefined) => boolean;

/**
 * In development, any origin: a developer runs the web app on whatever port is
 * free, and locking that down buys nothing because there is no real session to
 * steal. In production, the allowlist only.
 */
export function originDecision(env: CorsEnv = process.env): OriginDecision {
  if (env.NODE_ENV !== "production") return () => true;

  const allowed = allowedOrigins(env);
  return (origin) => {
    // No Origin header at all: curl, a server-to-server call, a same-origin
    // navigation. There is no browser to protect, so there is nothing for CORS
    // to decide — authorization still applies as it does to every request.
    if (!origin) return true;
    return allowed.includes(normalize(origin));
  };
}
