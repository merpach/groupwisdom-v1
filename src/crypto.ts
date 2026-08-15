/**
 * Field-level encryption at rest for message-derived content.
 *
 * SQLite has no native encryption, and the database file sits on a hosting
 * volume with its backups. Every field that carries what a community said —
 * item titles and bodies, the distilled memory, knowledge docs, summaries —
 * is encrypted before it touches disk and decrypted inside the data layer,
 * so the rest of the app never knows. What this protects against is the file
 * itself: a copied volume, a leaked backup, a misconfigured mount. What it
 * cannot protect against is a compromise of the running server, which
 * necessarily holds the key.
 *
 * Key: GW_DATA_KEY, any string; it is stretched to 256 bits with SHA-256.
 * Without a key set, storage stays plaintext (local dev keeps working) and a
 * warning says so.
 *
 * Format: "enc1:" + base64(iv | tag | ciphertext), AES-256-GCM. Values not
 * starting with the prefix are returned unchanged, which is what makes the
 * rollout safe on a live database: old plaintext rows keep reading, new
 * writes are encrypted, and a one-time boot sweep converts the backlog.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "enc1:";

let cachedKey: Buffer | null | undefined;

function dataKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const raw = process.env.GW_DATA_KEY?.trim();
  cachedKey = raw ? createHash("sha256").update(raw).digest() : null;
  return cachedKey;
}

export const encryptionEnabled = () => dataKey() !== null;

/** Is this value already encrypted? (Used by the boot sweep to skip done rows.) */
export const isEncrypted = (v: string) => v.startsWith(PREFIX);

export function encryptField(plain: string): string {
  const key = dataKey();
  if (!key || plain === "" || isEncrypted(plain)) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptField(stored: string): string {
  if (!stored || !isEncrypted(stored)) return stored;   // legacy plaintext row
  const key = dataKey();
  if (!key) {
    // Encrypted data but no key: never hand ciphertext onward as if it were
    // text — the engine would summarise gibberish into memory.
    throw new Error("GW_DATA_KEY is not set but the database contains encrypted data");
  }
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Test hook: forget the cached key so a test can flip GW_DATA_KEY. */
export function _resetKeyCache() { cachedKey = undefined; }
