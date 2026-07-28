/**
 * NIP-OA (Owner Attestation) + NIP-AA (Agent Authentication).
 *
 * This is what lets GroupWisdom join *anyone's* Buzz community without a relay
 * operator enrolling it as a member.
 *
 * A Buzz user (the "owner") signs a short attestation authorizing GroupWisdom's
 * agent key to act on their behalf. The agent then presents that attestation as an
 * `auth` tag inside its NIP-42 AUTH event, and the relay grants access derived from
 * the owner's own membership — "virtual membership" in NIP-AA terms. If the owner
 * later leaves the community, the agent's access dies with it, automatically.
 *
 * Signing construction (NIP-OA §The Tag):
 *   preimage = "nostr:agent-auth:" || <agent-pubkey-hex> || ":" || <conditions>
 *   message  = SHA256(preimage)
 *   sig      = BIP-340 Schnorr signature over `message` by the OWNER's key
 *   tag      = ["auth", <owner-pubkey-hex>, <conditions>, <sig-hex>]
 *
 * Verified byte-for-byte against the spec test vector in block/buzz
 * (crates/buzz-sdk/src/nip_oa.rs). See nip-oa.test.ts.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

const DOMAIN_SEPARATOR = "nostr:agent-auth:";
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export type AuthTag = ["auth", string, string, string];

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Validate a NIP-OA conditions string.
 *
 * Either empty, or `clause` / `clause&clause&…` where each clause is one of
 * `kind=<n>`, `created_at<<t>`, `created_at><t>`. Decimals must be canonical
 * (no leading zeroes except "0"), and no whitespace is permitted anywhere.
 */
export function validateConditions(conditions: string): void {
  if (conditions === "") return;                       // empty imposes no constraints
  if (/\s/.test(conditions)) throw new Error("conditions must not contain whitespace");
  if (conditions.startsWith("&") || conditions.endsWith("&") || conditions.includes("&&")) {
    throw new Error("malformed conditions: empty clause");
  }

  const checkDecimal = (raw: string, label: string, max: number) => {
    if (!/^[0-9]+$/.test(raw)) throw new Error(`${label}: value must be decimal digits`);
    if (raw.length > 1 && raw.startsWith("0")) throw new Error(`${label}: leading zeroes not allowed`);
    const n = Number(raw);
    if (n > max) throw new Error(`${label}: value ${n} out of range [0, ${max}]`);
  };

  for (const clause of conditions.split("&")) {
    if (clause.startsWith("kind=")) {
      checkDecimal(clause.slice(5), "kind", 65535);
    } else if (clause.startsWith("created_at<")) {
      checkDecimal(clause.slice(11), "created_at<", 4294967295);
    } else if (clause.startsWith("created_at>")) {
      checkDecimal(clause.slice(11), "created_at>", 4294967295);
    } else {
      throw new Error(`unsupported clause: "${clause}"`);
    }
  }
}

/** The exact byte sequence the owner signs. */
export function buildPreimage(agentPubkeyHex: string, conditions: string): string {
  return `${DOMAIN_SEPARATOR}${agentPubkeyHex}:${conditions}`;
}

function messageHash(agentPubkeyHex: string, conditions: string): Uint8Array {
  return sha256(new TextEncoder().encode(buildPreimage(agentPubkeyHex, conditions)));
}

/**
 * Owner-side: mint an attestation authorizing `agentPubkeyHex` to act for the owner.
 * This is the artifact a Buzz user hands to GroupWisdom to "install" it.
 */
export function computeAuthTag(
  ownerSecretKey: Uint8Array,
  agentPubkeyHex: string,
  conditions = "",
): AuthTag {
  if (!HEX64.test(agentPubkeyHex)) throw new Error("agent pubkey must be 64 lowercase hex chars");
  const ownerPubkeyHex = bytesToHex(schnorr.getPublicKey(ownerSecretKey));
  if (ownerPubkeyHex === agentPubkeyHex) throw new Error("self-attestation rejected: owner and agent keys must differ");
  validateConditions(conditions);

  const sig = schnorr.sign(messageHash(agentPubkeyHex, conditions), ownerSecretKey);
  return ["auth", ownerPubkeyHex, conditions, bytesToHex(sig)];
}

/**
 * Verify an attestation really authorizes `agentPubkeyHex`.
 * Returns the owner's pubkey hex. Throws with a specific reason on failure.
 *
 * Note this is the NIP-AA verification subset: `kind=` clauses are not evaluated
 * here (they constrain published events, not the AUTH handshake).
 */
export function verifyAuthTag(tag: unknown, agentPubkeyHex: string): string {
  if (!Array.isArray(tag) || tag.length !== 4) throw new Error("auth tag must have exactly 4 elements");
  const [label, ownerPubkeyHex, conditions, sigHex] = tag as string[];
  if (label !== "auth") throw new Error('first element must be "auth"');
  if (!HEX64.test(ownerPubkeyHex)) throw new Error("owner pubkey must be 64 lowercase hex chars");
  if (!HEX128.test(sigHex)) throw new Error("signature must be 128 lowercase hex chars");
  if (ownerPubkeyHex === agentPubkeyHex) throw new Error("self-attestation rejected");
  validateConditions(conditions);

  const ok = schnorr.verify(hexToBytes(sigHex), messageHash(agentPubkeyHex, conditions), hexToBytes(ownerPubkeyHex));
  if (!ok) throw new Error("signature does not verify for this owner and agent key");
  return ownerPubkeyHex;
}

/** Parse an attestation from its JSON string form, as stored in config. */
export function parseAuthTag(json: string): AuthTag {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch (e) { throw new Error(`invalid auth tag JSON: ${(e as Error).message}`); }
  if (!Array.isArray(parsed) || parsed.length !== 4) throw new Error("auth tag must be a 4-element JSON array");
  return parsed as AuthTag;
}

/**
 * Check the timestamp clauses against a candidate event time.
 * NIP-AA Step 4.9: the AUTH event must satisfy any created_at clauses.
 */
export function satisfiesTimestampClauses(conditions: string, createdAt: number): boolean {
  if (conditions === "") return true;
  for (const clause of conditions.split("&")) {
    if (clause.startsWith("created_at<") && !(createdAt < Number(clause.slice(11)))) return false;
    if (clause.startsWith("created_at>") && !(createdAt > Number(clause.slice(11)))) return false;
  }
  return true;
}
