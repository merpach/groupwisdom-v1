/**
 * Mint a NIP-OA attestation authorizing GroupWisdom to act in your Buzz community.
 * This is the "install" step — run once, paste the result into GroupWisdom's config.
 *
 *   npm run buzz:authorize -- <your-nsec-or-hex> <groupwisdom-agent-pubkey> [conditions]
 *
 * Your secret key never leaves this process: it signs locally and only the
 * signature is printed. GroupWisdom never sees it.
 *
 * The attestation grants GroupWisdom access to any community where YOU are a
 * member, derived from your membership — no relay operator involvement. Revoke
 * by leaving the community, or by minting a time-bounded attestation:
 *
 *   npm run buzz:authorize -- <nsec> <agent-pubkey> "created_at<1800000000"
 */
import { computeAuthTag } from "./adapters/nip-oa.js";
import { decode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";

const [ownerKeyArg, agentPubkey, conditions = ""] = process.argv.slice(2);

if (!ownerKeyArg || !agentPubkey) {
  console.error(
    "Usage: npm run buzz:authorize -- <your-nsec-or-hex> <groupwisdom-agent-pubkey> [conditions]\n\n" +
    "  <your-nsec-or-hex>   your Buzz identity's secret key (never transmitted)\n" +
    "  <agent-pubkey>       GroupWisdom's agent public key, 64 hex chars\n" +
    "  [conditions]         optional, e.g. \"created_at<1800000000\" to expire the grant\n",
  );
  process.exit(1);
}

function toSecretKey(key: string): Uint8Array {
  if (key.startsWith("nsec")) {
    const { type, data } = decode(key);
    if (type !== "nsec") throw new Error("expected an nsec key");
    return data as Uint8Array;
  }
  const clean = key.trim().replace(/^0x/, "");
  if (clean.length !== 64) throw new Error("secret key hex must be 64 chars");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

try {
  const sk = toSecretKey(ownerKeyArg);
  const tag = computeAuthTag(sk, agentPubkey.trim().toLowerCase(), conditions);

  console.log("\nAttestation minted. You authorized GroupWisdom as:");
  console.log(`  owner      ${getPublicKey(sk)}`);
  console.log(`  agent      ${agentPubkey}`);
  console.log(`  conditions ${conditions || "(none — valid until you leave the community)"}\n`);
  console.log("Give this to GroupWisdom (set as BUZZ_AUTH_TAG):\n");
  console.log(JSON.stringify(tag));
  console.log("\nYour secret key was not transmitted — only the signature above.\n");
} catch (e) {
  console.error(`Could not mint attestation: ${(e as Error).message}`);
  process.exit(1);
}
