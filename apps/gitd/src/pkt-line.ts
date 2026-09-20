/**
 * pkt-line framing (Git wire protocol).
 *
 * Every message is a 4-byte hex length prefix covering itself plus the
 * payload; "0000" is a flush packet. The service advertisement is the only
 * part of smart HTTP we have to frame ourselves — everything after it is
 * produced by git's own plumbing.
 */
export const FLUSH = "0000";

export function pktLine(payload: string): string {
  const length = Buffer.byteLength(payload) + 4;
  if (length > 0xffff) throw new Error("pkt-line payload too long");
  return length.toString(16).padStart(4, "0") + payload;
}

/** `# service=git-upload-pack` banner that must precede the ref advertisement. */
export function serviceAdvertisement(service: string): Buffer {
  return Buffer.from(pktLine(`# service=${service}\n`) + FLUSH, "utf8");
}

export interface RefUpdate { oldOid: string; newOid: string; ref: string }

/**
 * Parse the ref updates a client proposes at the head of a receive-pack body.
 *
 * Only the command list is read; the packfile that follows is passed through
 * untouched. We need the list to know which commits arrived so their
 * provenance can be recomputed — a push must not be able to assert its own.
 */
export function parseReceivePackCommands(body: Buffer): RefUpdate[] {
  const updates: RefUpdate[] = [];
  let offset = 0;

  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString("utf8");
    if (header === FLUSH) break;
    const length = parseInt(header, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > body.length) break;

    const line = body.subarray(offset + 4, offset + length).toString("utf8");
    offset += length;

    // "<old> <new> <ref>\0capabilities" on the first line only.
    const [command] = line.split("\0");
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+?)\s*$/.exec(command ?? "");
    if (match) updates.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }
  return updates;
}

export const ZERO_OID = "0".repeat(40);
export const isCreate = (u: RefUpdate) => u.oldOid === ZERO_OID;
export const isDelete = (u: RefUpdate) => u.newOid === ZERO_OID;
