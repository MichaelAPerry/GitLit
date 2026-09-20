/**
 * What must never leave this process.
 *
 * GitLit's whole proposition is that an author's manuscript and their identity
 * are theirs. An error monitor is a pipe to a third party that runs on the
 * unhappy path — exactly when payloads are largest and least expected — so the
 * scrubbing has to be a deny-by-default filter over the whole event, not a
 * list of fields someone remembered to redact.
 *
 * This runs on every event before it is sent, and there is no code path to
 * Sentry that skips it.
 */

export const REDACTED = "[redacted]";

/**
 * Credential shapes (`packages/auth/src/secrets.ts`): a three-part token with
 * a known prefix. Matched anywhere in a string, including inside a URL, a
 * stack frame or a log message that happened to interpolate one.
 */
const CREDENTIAL_RE = /\b(glm|gls|glt|glo)_[0-9a-f]{18}_[0-9a-f]{64}\b/g;

/** A bearer/basic header value, whatever the credential inside it looks like. */
const AUTH_HEADER_RE = /\b(bearer|basic|token)\s+\S+/gi;

/** Addresses. Not a validator — deliberately greedy, because a false positive costs nothing. */
const EMAIL_RE = /\b[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+\b/g;

/**
 * Keys whose VALUE is dropped wholesale, whatever it contains.
 *
 * `content`, `text` and `prose` are here because they carry manuscript: an
 * exception thrown from the commit path can have a whole chapter on it, and a
 * chapter in a third-party error tracker is the thing GitLit exists to prevent.
 */
const DENY_KEYS = new Set([
  "authorization", "cookie", "setcookie", "xapikey",
  "token", "sessiontoken", "devtoken", "credential", "password", "secret",
  "apikey", "resendapikey", "signingmasterkey", "gitdservicetoken", "privatekey",
  "email", "to", "from", "replyto",
  "content", "text", "prose", "excerpt", "body", "html",
  "spans", "patch", "diff",
]);

/**
 * Compare key names with separators removed, not just lowercased.
 *
 * The same field arrives as `set-cookie`, `SET_COOKIE` and `setCookie`
 * depending on whether it came from a header map, an environment variable or
 * a JS object — and a deny list that matches one spelling of a secret is a
 * deny list that leaks the other two.
 */
const normalizeKey = (key: string) => key.toLowerCase().replace(/[-_\s]/g, "");
const isDenied = (key: string) => DENY_KEYS.has(normalizeKey(key));

/** Redact credentials, addresses and auth headers from free text. */
export function scrubString(value: string): string {
  return value
    .replace(CREDENTIAL_RE, `$1_${REDACTED}`)
    .replace(AUTH_HEADER_RE, (m) => `${m.split(/\s+/)[0]} ${REDACTED}`)
    .replace(EMAIL_RE, REDACTED);
}

/**
 * Walk an arbitrary structure, dropping denied keys and scrubbing every
 * string. Cycles are tolerated: an event built from a live request object can
 * easily contain one, and throwing here would lose the error entirely.
 */
export function scrubValue<T>(input: T, seen = new WeakSet<object>(), depth = 0): T {
  // Deep structures are truncated rather than followed. An unbounded walk on a
  // hostile or accidental deep object is a denial of service in the error path.
  if (depth > 12) return REDACTED as unknown as T;
  if (typeof input === "string") return scrubString(input) as unknown as T;
  if (input === null || typeof input !== "object") return input;

  const obj = input as unknown as object;
  if (seen.has(obj)) return REDACTED as unknown as T;
  seen.add(obj);

  if (Array.isArray(input)) {
    return input.map((v) => scrubValue(v, seen, depth + 1)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isDenied(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = scrubValue(value, seen, depth + 1);
  }
  return out as unknown as T;
}

/**
 * A query string is scrubbed whole: a magic-link token arrives as
 * `?token=glm_…`, and the emailed URL is the credential itself.
 */
export function scrubUrl(url: string): string {
  const [path, query] = url.split("?", 2);
  if (!query) return scrubString(path ?? url);
  const params = new URLSearchParams(query);
  for (const key of [...params.keys()]) {
    params.set(key, isDenied(key) ? REDACTED : scrubString(params.get(key) ?? ""));
  }
  return `${scrubString(path ?? "")}?${params.toString()}`;
}
