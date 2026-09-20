import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { generateSigningKey, type KeyPair } from "@gitlit/provenance";

/**
 * Durable signing keys (§7.4).
 *
 * These were previously held in a Map, which meant a restart regenerated them
 * and every receipt issued beforehand became permanently unverifiable. That is
 * not a missing feature — it inverts the product's central claim, that a
 * clone's provenance can be verified offline for as long as the repository
 * exists. Keys must outlive the process.
 *
 * Stored beside the bare repo, outside the object store so they are never
 * committed or served, and wrapped with AES-256-GCM when SIGNING_MASTER_KEY is
 * set. Production replaces the wrap with KMS; the persistence contract here is
 * the same either way.
 */

const FILENAME = "gitlit-signing-key.json";

interface StoredKey { keyId: string; publicKey: string; privateKey: string; wrapped: boolean }

function masterKey(): Buffer | null {
  const secret = process.env.SIGNING_MASTER_KEY;
  if (!secret) {
    /**
     * Required in production (§2.5).
     *
     * Without it the Ed25519 private key that signs every receipt sits in
     * plaintext on the volume, and the volume is the thing most likely to be
     * snapshotted, backed up and copied around. Unset, gitd comes up and works
     * perfectly — which is why this has to be a refusal to start rather than a
     * warning nobody reads.
     */
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "SIGNING_MASTER_KEY must be set in production. Without it the signing keys " +
          "that make receipts verifiable are stored unencrypted on the repository volume.",
      );
    }
    return null;
  }
  return scryptSync(secret, "gitlit-signing-key-v1", 32);
}

function wrap(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

function unwrap(payload: string, key: Buffer): string {
  const [iv, tag, data] = payload.split(".");
  if (!iv || !tag || !data) throw new Error("Malformed wrapped signing key");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

export class KeyStore {
  private cache = new Map<string, KeyPair>();

  constructor(private readonly resolveGitdir: (repoId: string) => string) {}

  private file(repoId: string): string {
    return path.join(this.resolveGitdir(repoId), FILENAME);
  }

  /**
   * Load the repo's key, creating it once on first use. Never regenerates a
   * key that already exists: doing so would silently orphan every receipt
   * already in the chain.
   */
  for(repoId: string): KeyPair {
    const cached = this.cache.get(repoId);
    if (cached) return cached;

    const file = this.file(repoId);
    const master = masterKey();

    if (fs.existsSync(file)) {
      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as StoredKey;
      if (stored.wrapped && !master) {
        throw new Error(
          `Signing key for ${repoId} is wrapped but SIGNING_MASTER_KEY is not set. ` +
          `Refusing to continue: issuing receipts under a new key would orphan the existing chain.`,
        );
      }
      const key: KeyPair = {
        keyId: stored.keyId,
        publicKey: stored.publicKey,
        privateKey: stored.wrapped ? unwrap(stored.privateKey, master!) : stored.privateKey,
      };
      this.cache.set(repoId, key);
      return key;
    }

    const key = generateSigningKey(`key_${repoId}`);
    const stored: StoredKey = {
      keyId: key.keyId,
      publicKey: key.publicKey,
      privateKey: master ? wrap(key.privateKey, master) : key.privateKey,
      wrapped: Boolean(master),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
    this.cache.set(repoId, key);
    return key;
  }

  /** Public half, for the offline verifier. Safe to serve. */
  publicKey(repoId: string): string {
    return this.for(repoId).publicKey;
  }
}
