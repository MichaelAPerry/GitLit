import { createHash, generateKeyPairSync, sign, verify, createPrivateKey, createPublicKey } from "node:crypto";

export interface ReceiptPayload {
  id: string;
  repo: string;
  commit: string;
  spansDigest: string;
  configVersion: string;
  session?: string;
  declaredModel?: string;
  issuedAt: string;
  /** SHA-256 over the previous receipt's canonical payload. Null for the first. */
  prev: string | null;
}

export interface Receipt extends ReceiptPayload {
  keyId: string;
  sig: string;
}

export interface KeyPair { keyId: string; publicKey: string; privateKey: string }

/** Ed25519 keypair, PEM-encoded. Private keys are KMS-wrapped at rest (§14). */
export function generateSigningKey(keyId: string): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/**
 * Canonical form. Key order is fixed here rather than taken from the object so
 * that verification is stable across runtimes and JSON implementations — a
 * receipt that verifies today must verify in ten years.
 */
export function canonical(p: ReceiptPayload): string {
  return JSON.stringify([
    p.id, p.repo, p.commit, p.spansDigest, p.configVersion,
    p.session ?? null, p.declaredModel ?? null, p.issuedAt, p.prev,
  ]);
}

export const payloadHash = (p: ReceiptPayload): string =>
  `sha256:${createHash("sha256").update(canonical(p)).digest("hex")}`;

export function issueReceipt(payload: ReceiptPayload, key: KeyPair): Receipt {
  const sig = sign(null, Buffer.from(canonical(payload)), createPrivateKey(key.privateKey));
  return { ...payload, keyId: key.keyId, sig: `ed25519:${sig.toString("base64")}` };
}

export function verifyReceipt(receipt: Receipt, publicKeyPem: string): boolean {
  if (!receipt.sig.startsWith("ed25519:")) return false;
  try {
    return verify(
      null,
      Buffer.from(canonical(receipt)),
      createPublicKey(publicKeyPem),
      Buffer.from(receipt.sig.slice("ed25519:".length), "base64"),
    );
  } catch {
    return false;
  }
}

export interface ChainResult {
  valid: boolean;
  verified: number;
  failures: { index: number; commit: string; reason: "bad_signature" | "broken_chain" }[];
}

/**
 * Walk the receipt chain (§7.4). Each receipt commits to the hash of the one
 * before it, so removing or reordering history breaks every receipt after the
 * tampered point. Runs offline against a clone — that is the whole purpose.
 */
export function verifyChain(receipts: Receipt[], publicKeys: Map<string, string>): ChainResult {
  const failures: ChainResult["failures"] = [];
  let prevHash: string | null = null;

  receipts.forEach((r, i) => {
    if (r.prev !== prevHash) failures.push({ index: i, commit: r.commit, reason: "broken_chain" });
    const pk = publicKeys.get(r.keyId);
    if (!pk || !verifyReceipt(r, pk)) {
      failures.push({ index: i, commit: r.commit, reason: "bad_signature" });
    }
    prevHash = payloadHash(r);
  });

  return { valid: failures.length === 0, verified: receipts.length - failures.length, failures };
}

export const toJsonl = (rs: Receipt[]): string => rs.map((r) => JSON.stringify(r)).join("\n") + "\n";
export const fromJsonl = (t: string): Receipt[] =>
  t.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Receipt);
