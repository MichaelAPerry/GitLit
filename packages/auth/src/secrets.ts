import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Credential material.
 *
 * Every credential here is 256 bits of CSPRNG output, so the stored
 * verifier is a plain SHA-256 digest rather than a password hash. scrypt and
 * friends exist to slow down guessing of LOW-entropy secrets; against a
 * uniformly random 32-byte token there is nothing to guess, and the KDF would
 * only add latency to every request. Passwords would need a real KDF — which
 * is one reason this system has none (see magic links in store.ts).
 */

const SECRET_BYTES = 32;

export interface IssuedSecret {
  /** Shown to the user exactly once. Never stored. */
  plaintext: string;
  /** Non-secret lookup handle, so verification is a point read, not a scan. */
  selector: string;
  /** What we persist. */
  verifier: string;
}

export const hashSecret = (secret: string): string =>
  createHash("sha256").update(secret).digest("hex");

/**
 * Issue a credential as `<prefix>_<selector>_<secret>`.
 *
 * The split matters: the selector finds the row and the secret is compared in
 * constant time. A single-part token forces either a table scan or a lookup
 * keyed by the secret itself, and the latter leaks through timing.
 */
export function issueSecret(prefix: string): IssuedSecret {
  // Hex, not base64url: base64url's alphabet contains "_", which is the
  // delimiter here, so a base64url payload can silently produce a token that
  // splits into more than three parts and never parses.
  const selector = randomBytes(9).toString("hex");
  const secret = randomBytes(SECRET_BYTES).toString("hex");
  return {
    plaintext: `${prefix}_${selector}_${secret}`,
    selector,
    verifier: hashSecret(secret),
  };
}

export interface ParsedSecret { prefix: string; selector: string; secret: string }

const TOKEN_RE = /^([a-z]{3})_([0-9a-f]{18})_([0-9a-f]{64})$/;

export function parseSecret(token: string): ParsedSecret | null {
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  return { prefix: m[1]!, selector: m[2]!, secret: m[3]! };
}

/** Constant-time comparison. Length mismatch is reported without branching on content. */
export function verifySecret(presented: string, storedVerifier: string): boolean {
  const a = Buffer.from(hashSecret(presented), "hex");
  const b = Buffer.from(storedVerifier, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
