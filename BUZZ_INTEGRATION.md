# GroupWisdom × Buzz — Integration Spec

**Source:** read of `github.com/block/buzz` (`NOSTR.md`, `VISION_AGENT.md`, `buzz-acp`, crate layout).
**Goal:** run GroupWisdom as a first-class Buzz agent — read a channel's contributions, surface wisdom, post it back.

---

## 1. What Buzz is, on the wire

Buzz is a **Nostr relay** speaking **NIP-29 (relay-based groups)**. Everything is a signed event over a WebSocket.

| Concept | Buzz / Nostr reality |
|---|---|
| Community | The relay URL/domain (one community per relay today) |
| Channel | A NIP-29 group, identified by a UUID, referenced with an `#h` tag |
| Message | **kind:9** event, `content` = text, must carry `#h <channel-uuid>` |
| Reaction | kind:7 (`#e` = target event) |
| Thread reply | kind:9 with `["e","<parent>","","reply"]` (NIP-10) |
| Identity | A Nostr keypair (npub/nsec) per human **and per agent** |
| Auth | **NIP-42** challenge/response; optional pubkey allowlist / relay membership (NIP-43) |
| Membership signal | kind:44100 (added) / 44101 (removed), relay-signed, community-global |
| Read live | `REQ {kinds:[9], "#h":["<uuid>"]}` streaming |
| Read history / search | Historical `REQ`, NIP-50 search, REST (`GET /api/channels?member=true`, thread queries) |

**The key insight:** a Buzz message already *is* a structured, signed, addressable contribution. The adapter Lassi's spec asks for (§3) is a thin field-mapping, and provenance (§10 sources, §16 receipts) is native.

---

## 1b. Multi-tenancy: how *anyone* installs GroupWisdom (NIP-AA)

The naive integration requires a relay operator to enrol GroupWisdom's key as a member of
each community — which doesn't scale and isn't something a product can ask for. Buzz solves
this natively with two of its own NIPs:

- **NIP-OA (Owner Attestation)** — an owner key signs a credential authorizing an agent key
  to act on its behalf. The agent remains the author of its events; this is authorization
  evidence, not impersonation.
- **NIP-AA (Agent Authentication)** — a relay grants an agent access *derived from its
  owner's membership* ("virtual membership"), with no membership record for the agent.

So GroupWisdom holds **one** keypair. Any Buzz user signs an attestation, and GroupWisdom
can then join *their* community with zero operator involvement. If that user later leaves,
the agent's next connection fails automatically — revocation is free.

**The signing construction** (`src/adapters/nip-oa.ts`, verified against the spec vector in
`crates/buzz-sdk/src/nip_oa.rs`):

```
preimage = "nostr:agent-auth:" || <agent-pubkey-hex> || ":" || <conditions>
message  = SHA256(preimage)
sig      = BIP-340 Schnorr over `message`, signed by the OWNER
tag      = ["auth", <owner-pubkey-hex>, <conditions>, <sig-hex>]
```

The tag is attached to the agent's NIP-42 `kind:22242` AUTH event. Conditions may bound the
grant in time (`created_at<…`), giving expiring authorizations.

**The install flow:**

```bash
# The user runs this once. Their secret key signs locally and is never transmitted.
npm run buzz:authorize -- <their-nsec> <groupwisdom-agent-pubkey>
# → ["auth","<their-pubkey>","","<sig>"]        ← set as BUZZ_AUTH_TAG
```

**Verified live** against `wss://groupwisdom.communities.buzz.xyz`, same fresh key both times:

| Attempt | Result |
|---|---|
| Brand-new key, no attestation | `REJECTED — restricted: not a relay member` |
| Same key + owner attestation | `GRANTED` → discovered all channels |

## 2. Integration architecture

GroupWisdom runs as **one agent identity** (a keypair) with two modes on the same connection:

```
                 Buzz Relay (Nostr, NIP-29, WS)
                   │   ▲
    kind:9 events  │   │  kind:9 wisdom (cites #e sources)
   (all messages)  ▼   │
        ┌───────────────────────────┐
        │   GroupWisdom Buzz adapter │  ← new module, src/adapters/buzz.ts
        │   (nostr-tools: keys,      │
        │    NIP-42 auth, REQ/EVENT) │
        └───────────────────────────┘
              │ six-field items │ wisdom
              ▼                 ▲
        ┌───────────────────────────┐
        │   GroupWisdom engine       │  ← existing two-pass engine, unchanged
        └───────────────────────────┘
```

**Mode A — Passive scout (push, the main integration).**
Subscribe to `kind:9` in each channel the agent belongs to → map every message to a contribution → run the engine → when wisdom clears the bar, post it back as a `kind:9` event citing its sources. Silence = emit nothing. This is "the scout runs on everything."

**Mode B — Ask / pull.**
Buzz's **`buzz-acp`** harness already "listens for @mentions and prompts your agent" over ACP. Wire GroupWisdom's `ask` behavior here so a member can `@groupwisdom what did we decide about the dataset?` and get an answer event back. Same identity, same channel.

Mode A is the product; Mode B is a fast, native pull channel that Buzz hands us for free.

---

## 3. The field mapping (the whole adapter, essentially)

**Buzz kind:9 → GroupWisdom item / spec six-field contribution:**

| Six-field (spec §2) | From the Nostr event |
|---|---|
| `id` | `event.id` |
| `context` | `#h` tag value (channel UUID) → GroupWisdom project |
| `source` | `event.pubkey` (resolve to display_name via kind:0 profile) |
| `time` | `event.created_at` |
| `type` | `"message"` (files/media map from Blossom refs later) |
| `content` | `event.content` |
| `meta` | `{ sig: event.sig, tags: event.tags, thread: <#e root> }` |

**GroupWisdom wisdom → Buzz kind:9 event (post-back):**

```jsonc
{
  "kind": 9,
  "content": "Sarah's redesign tested 22% faster and James's interviews show users prefer one-tap — together that's your case for shipping one-tap checkout.",
  "tags": [
    ["h", "<channel-uuid>"],          // the room
    ["e", "<sarah_msg_id>"],          // sources[] — native citation
    ["e", "<james_msg_id>"],
    ["t", "convergence"]              // the wisdom kind
  ]
}
```

The `#e` tags **are** the spec's `sources[]` — every wisdom card is provable in one click, natively. Optionally reply-thread the wisdom under the triggering message via NIP-10.

---

## 4. Why this closes Lassi's spec gaps for free

| Spec gap (from delta report) | Buzz gives natively |
|---|---|
| §16.2 plaintext API keys | Cryptographic keypair identity; every event Schnorr-signed |
| §10 `sources[]` / §16 receipts (audit in one step) | `#e` tags + immutable signed events |
| §2 `context` isolation / §16.1 sealed rooms | NIP-29 channel scoping, membership-gated |
| §16 provenance ("who authorized this") | "Authorization does not erase authorship — the agent remains the author" |
| §6 webhook delivery | Post a kind:9 event; the channel *is* the delivery surface |
| §1.3 "developer's app shows a card" | Buzz **is** the app — no client to build |

The integration doesn't just add a channel — it retires several of the spec's hardest security/identity line items.

---

## 5. What to build in GroupWisdom

1. **`src/adapters/buzz.ts`** — the only real new code:
   - `nostr-tools` (npm) for keygen, event signing (secp256k1/Schnorr), NIP-42 auth, WS `REQ`/`EVENT`.
   - Connect + authenticate; subscribe to `kind:9` per channel and to `kind:44100 #p=<self>` to auto-join new channels.
   - `eventToItem(event)` (mapping above) → call existing `addItem` / `queueIncrementalAnalysis`.
   - `wisdomToEvent(wisdom, sources)` → sign + publish kind:9 with `#e` citations.
2. **Config:** `BUZZ_RELAY_URL`, `BUZZ_PRIVATE_KEY` (agent nsec), channel→project map. Keys via a secrets manager, never in code (spec §16.3).
3. **Engine:** unchanged. One channel = one context/project. (This is where flipping to silence-first, from the delta report, actually pays off — a chatty channel with a noisy agent is worse than useless.)
4. **Ask mode (later):** an ACP shim so `buzz-acp` can invoke GroupWisdom's `ask` on @mention.

Nothing in the core engine changes. The adapter is the bridge, exactly as the spec's §3 predicts.

---

## 6. Phased plan

- **v0 — Prove it (days).** Run a local relay (`just relay`), mint an agent key (`buzz-admin generate-key`), add it as a member. Adapter subscribes to one channel, maps messages to items, runs the engine, posts one wisdom card back citing `#e` sources. Screen-record for the demo.
- **v1 — Native scout.** Multi-channel via membership auto-subscribe, profile resolution (kind:0), thread-replies, per-channel project isolation, silence-first tuning.
- **v2 — Full shape.** ACP ask/pull mode, labels (confidence/urgency once clocks exist), retractions on kind:5 deletions (maps straight to spec §16.1 "Forgetting").

---

## 7. Open questions / to verify before building

1. **Hosted vs self-host for the demo.** buzz.xyz (Block-hosted) vs `just relay` locally. Local is fastest to prototype and avoids allowlist friction.
2. **Private-channel membership API gap.** The repo notes there's no REST/event API yet to add members to private channels — creator is auto-member. May constrain how the agent joins private channels; confirm current state.
3. **Rich wisdom rendering.** kind:40002 (rich content) / 40003 (edits) exist but are "Buzz-only" (standard NIP-29 clients won't render them). Use plain kind:9 for portability; consider kind:40002 for a nicer card *inside* Buzz.
4. **Rate / cost.** Scout runs on every kind:9. Confirm the two-pass Haiku cost holds at channel volume; the spec's memory discipline matters here.

---

## Bottom line

Buzz is the best possible home for GroupWisdom: it supplies the identity, signing, audit trail, sealed rooms, and delivery surface the spec assumes we'd build — and it *wants* third-party agents. The entire integration is one adapter module (`nostr-tools` in, kind:9 out); the engine is untouched. v0 is a few days to a live, cited wisdom card posted into a real Buzz channel.
