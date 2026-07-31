/**
 * Redeem a Buzz invite link on the agent's behalf.
 *
 * Buzz's member UI hands out invite *links*, not a field to paste a pubkey into,
 * so "invite this npub" is not something a user can actually do there. This
 * takes the link they were given and joins the community with the agent's key,
 * which is the flow that actually works.
 *
 * The link carries the community too — https://<community-host>/invite/<code> —
 * so one paste yields both the relay URL and the code.
 *
 * Three calls, in order (see block/buzz crates/buzz-relay/src/api/invites.rs):
 *   GET  /api/join-policy            → the policy version currently in force
 *   POST /api/invites/accept-policy  → a receipt bound to this code + version
 *   POST /api/invites/claim          → NIP-98 signed by the agent; joins it
 *
 * The claim is deliberately exempt from the membership gate — the whole point is
 * that the caller is not a member yet. NIP-98 proves control of the joining key;
 * the HMAC inside the code proves an admin authorised the join.
 */
import { getToken } from "nostr-tools/nip98";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { decode as nip19decode } from "nostr-tools/nip19";

export type InviteTarget = {
  /** wss:// URL for the community the invite belongs to. */
  relayUrl: string;
  /** The opaque invite code from the link. */
  code: string;
  /** https:// base used for the REST calls. */
  apiBase: string;
};

/** Pull the community and code out of an invite link (or a bare code + host). */
export function parseInviteLink(input: string): InviteTarget {
  const raw = input.trim();
  if (!raw) throw new Error("Paste the invite link from Buzz.");

  let url: URL;
  try {
    url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    throw new Error("That doesn't look like a Buzz invite link.");
  }

  const match = url.pathname.match(/\/invite\/(.+)$/);
  if (!match || !match[1]) {
    throw new Error("That link has no invite code in it — it should look like https://your-community…/invite/…");
  }

  return {
    relayUrl: `wss://${url.host}`,
    apiBase: `https://${url.host}`,
    code: decodeURIComponent(match[1]),
  };
}

function toSecretKey(key: string): Uint8Array {
  if (key.startsWith("nsec")) {
    const { type, data } = nip19decode(key);
    if (type !== "nsec") throw new Error("expected an nsec key");
    return data as Uint8Array;
  }
  const clean = key.trim().replace(/^0x/, "");
  if (clean.length !== 64) throw new Error("agent key must be nsec or 64-char hex");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
}

export type RedeemResult = {
  relayUrl: string;
  status: "joined" | "already_member";
  agentPubkey: string;
};

/**
 * Join the community behind `inviteInput` as the agent.
 * Idempotent: an already-redeemed invite for this key reports already_member.
 */
export async function redeemBuzzInvite(inviteInput: string, agentKey: string): Promise<RedeemResult> {
  const target = parseInviteLink(inviteInput);
  const sk = toSecretKey(agentKey);
  const agentPubkey = getPublicKey(sk);

  // 1. What policy is in force? Some communities require accepting terms first.
  let policyVersion: string | null = null;
  try {
    const res = await fetch(`${target.apiBase}/api/join-policy`);
    if (res.ok) {
      const body = await readJson(res);
      policyVersion = body?.policy?.version ?? null;
    }
  } catch { /* no policy endpoint — treat as not required */ }

  // 2. Accept it, producing a receipt bound to this specific code.
  let policyReceipt: string | undefined;
  if (policyVersion) {
    const res = await fetch(`${target.apiBase}/api/invites/accept-policy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: target.code, policy_version: policyVersion, age_confirmed: true }),
    });
    const body = await readJson(res);
    if (!res.ok || !body?.receipt) {
      throw new Error(`Buzz would not accept the join policy: ${body?.error ?? res.status}`);
    }
    policyReceipt = body.receipt;
  }

  // 3. Claim, signed with NIP-98. The payload must be passed as an object —
  //    getToken hashes JSON.stringify(payload), so handing it a pre-stringified
  //    body produces a hash the relay rejects as a payload mismatch.
  const payload: Record<string, unknown> = { code: target.code };
  if (policyReceipt) payload.policy_receipt = policyReceipt;

  const url = `${target.apiBase}/api/invites/claim`;
  const token = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, payload);

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await readJson(res);

  if (!res.ok) {
    const err = String(body?.error ?? res.status);
    if (/expired/i.test(err)) throw new Error("That invite link has expired — generate a fresh one in Buzz.");
    if (/invite_invalid|not found/i.test(err)) throw new Error("Buzz rejected that invite code. Check the link, or generate a new one.");
    if (/too many/i.test(err)) throw new Error("Buzz is rate-limiting invite claims. Wait a minute and try again.");
    throw new Error(`Buzz rejected the invite: ${err}`);
  }

  const status = body?.status === "already_member" ? "already_member" : "joined";
  return { relayUrl: target.relayUrl, status, agentPubkey };
}
