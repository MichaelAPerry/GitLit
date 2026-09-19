import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * ULID: lexicographically sortable, timestamp-prefixed. Used for every
 * primary key in the schema so that natural key order is creation order —
 * which matters because the timeline is a range scan (§10).
 */
export function ulid(now: number = Date.now()): string {
  let ts = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[t % 32]! + ts;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! % 32]!;
  return ts + rand;
}

export const prefixed = (prefix: string) => (): string => `${prefix}_${ulid()}`;

export const newUserId = prefixed("u");
export const newRepoId = prefixed("repo");
export const newAgentSessionId = prefixed("sess");
export const newReceiptId = prefixed("rcpt");
export const newAuthoringSessionId = prefixed("as");
export const newDocumentId = prefixed("doc");
