/**
 * Buzz adapter — runs GroupWisdom as a first-class agent inside a Buzz (Nostr/NIP-29) workspace.
 *
 * The loop (see BUZZ_INTEGRATION.md):
 *   1. Listen  — subscribe to kind:9 messages in the agent's channels.
 *   2. Map     — each event → an ingest call against the real GroupWisdom /v1 API.
 *   3. Think   — the API's own two-pass engine runs, server-side, on your account.
 *   4. Speak   — poll for new wisdom, post it back as a kind:9 event citing sources.
 *
 * This talks to GroupWisdom exactly the way any external integration would — over the
 * public HTTP API, authenticated with your personal API key — not by importing the
 * engine in-process. Every project this creates is prefixed "Buzz: " and is additive:
 * it never reads, modifies, or deletes anything else in your account.
 *
 * This module does NOT touch the Express server. It's started standalone via `npm run buzz`
 * (src/buzz-run.ts), so nothing here affects the running app unless BUZZ_* env vars are set.
 *
 * Wire protocol reference: block/buzz NOSTR.md
 *   - kind:9   channel message, requires #h <channel-uuid>
 *   - kind:0   profile metadata (we publish a "GroupWisdom" display name once)
 *   - kind:44100/44101  membership added/removed (relay-signed, #p = your pubkey)
 *   - kind:39000  channel metadata — queried with no filter for one-shot discovery
 *   - NIP-42   AUTH: relay sends ["AUTH", challenge]; we reply ["AUTH", signed kind:22242]
 */
import { readFileSync, writeFileSync } from "node:fs";
import WebSocket from "ws";
import { finalizeEvent, getPublicKey, type Event, type EventTemplate } from "nostr-tools/pure";
import { makeAuthEvent } from "nostr-tools/nip42";
import { decode as nip19decode } from "nostr-tools/nip19";
import { verifyAuthTag, type AuthTag } from "./nip-oa.js";
import { truncate } from "../text-util.js";
import { scopeMemory, channelScopeEnabled, type ScopableMemory } from "../channel-scope.js";

// ── Config ──────────────────────────────────────────────────────────────────

export interface BuzzConfig {
  relayUrl: string;              // e.g. wss://your-community.communities.buzz.xyz
  privateKey: string;            // nsec1... or 64-char hex — the agent's Nostr identity
  groupwisdomApiKey: string;     // gw_... — the GroupWisdom API key for this workspace
  /**
   * NIP-OA attestation from a member of this community, authorizing our agent key.
   * When present, the relay grants access derived from that owner's membership
   * (NIP-AA "virtual membership") — so GroupWisdom can join any community whose
   * user authorized it, with no operator enrolling us as a member.
   */
  authTag?: AuthTag;
  groupwisdomBaseUrl?: string;   // default: the production GroupWisdom API
  /**
   * Restrict to these channel uuids. When set, discovery is used only to learn
   * channel names — nothing outside the list is watched, ingested, or billed.
   * When omitted, every channel the identity can see is watched.
   */
  channels?: string[];
  /** Called as channels are discovered, so a host can offer them as choices. */
  onChannelsDiscovered?: (channels: Array<{ id: string; name: string }>) => void;
  /** Read-only: never ingest or post. For safe connection tests. */
  dryRun?: boolean;
  /** Where to persist the per-channel cursor so no message is lost across restarts. */
  cursorFile?: string;
  /**
   * Durable cursor storage. Supply this when running somewhere with an ephemeral
   * filesystem (Railway wipes the container on every deploy) — otherwise the
   * cursor is lost on restart and messages are re-ingested and re-billed.
   * Defaults to the file at `cursorFile`.
   */
  cursorStore?: {
    load(): string | null;
    save(state: string): void;
  };
  onLog?: (msg: string) => void;
}

/**
 * Names @mentioned in a message, in order, deduped.
 *
 * The @ must open the token or follow whitespace, so an email address is not a
 * mention — matching "foo@example.com" would teach the adapter that somebody is
 * called "example.com" and then attribute real work to them.
 */
export function parseMentions(content: string): string[] {
  const out: string[] = [];
  for (const m of String(content ?? "").matchAll(/(?<=^|\s)@([A-Za-z0-9_][A-Za-z0-9_.-]{0,31})/g)) {
    const name = m[1].replace(/[._-]+$/, "");   // drop trailing punctuation: "@Marketer." → "Marketer"
    if (name) out.push(name);
  }
  return [...new Set(out)];
}

/**
 * Is this message addressed to us, and if so which command does it carry?
 *
 * Deliberately text-based rather than relying on Buzz resolving a formal
 * handle, because we do not control how a mention is rendered and it has to
 * work either way: "@wisdom memory", "@Wisdom Agent memory", or a message that
 * tags our pubkey. Anything addressed to us that is not a known command returns
 * null and flows on to be read as an ordinary contribution.
 */
const COMMAND_ALIASES = new Set(["wisdom", "wisdomagent", "groupwisdom"]);
const KNOWN_COMMANDS = new Set(["memory"]);

export function parseCommand(content: string, opts?: { taggedUs?: boolean }): { name: string; args: string } | null {
  const text = String(content ?? "").trim();
  const addressed = opts?.taggedUs === true ||
    parseMentions(text).some(m => COMMAND_ALIASES.has(m.toLowerCase().replace(/[._-]/g, "")));
  if (!addressed) return null;

  const rest = text
    .replace(/(?<=^|\s)@[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}/g, " ")   // drop the mention itself
    .replace(/^\s*agent\b/i, "")                                   // "@Wisdom Agent memory" → "memory"
    .trim();
  const [first, ...args] = rest.split(/\s+/);
  const name = (first ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!KNOWN_COMMANDS.has(name)) return null;
  return { name, args: args.join(" ").trim() };
}

/**
 * Two marks are the whole alphabet in chat: 💡 for something worth knowing,
 * ⚠ for something that needs attention. The six kinds stay intact in the API
 * and the dashboard; this is only how they look in a channel.
 *
 * Only `tension` earns the warning, because it is the one kind that names a
 * conflict, whether that is two readings of the same evidence or two bookings
 * that cannot both stand. `opportunity` is deliberately a lamp rather than a
 * warning: it is an opening the group's own work created, not a gap it failed
 * to close.
 */
export const markFor = (kind: string) => (kind === "tension" ? "⚠" : "💡");

/**
 * A mark, a headline, a body, and nothing else. No labels, no confidence, no
 * sources, no footer: those stay complete in the API object and the dashboard.
 */
export function formatCard(kind: string, title: string, body: string): string {
  return `${markFor(kind)} ${title.trim()}\n${body.trim()}`;
}

/**
 * May this card be posted into this channel?
 *
 * A finding is drawn for one channel, from only what that channel can see, and
 * belongs nowhere else. Wisdom carrying no channel is refused too: it was drawn
 * without that restriction, so it may rest on any channel in the community.
 * With scoping off, everything is postable and this is the old behaviour.
 */
export function postableInChannel(w: { channel?: string | null }, channel: string): boolean {
  if (!channelScopeEnabled()) return true;
  return !!w.channel && w.channel === channel;
}

/**
 * Hold a memory answer to the channel that asked for it.
 *
 * Reciting memory back is not the same as acting on it: answering "what do you
 * know" in one channel with facts drawn from another hands someone messages
 * they were never sent. So a fact survives only if it traces to a message this
 * channel may see, and this caller runs strict, withholding anything it cannot
 * place at all. A single-channel community has nothing to leak into and is
 * passed through untouched.
 *
 * The tracing rule itself lives in channel-scope, shared with the engine so
 * both sides place a fact the same way. See `visibleTo` there for why strict
 * is right here and wrong for a scan.
 */
export function scopeMemoryToChannel(
  mem: ScopableMemory,
  channel: string,
  items: Array<{ id?: string; channel?: string | null }>,
  opts: { multiChannel: boolean },
): { memory: ScopableMemory; hidden: number; scoped: boolean } {
  if (!opts.multiChannel || !channelScopeEnabled()) return { memory: mem, hidden: 0, scoped: false };
  const { memory, hidden } = scopeMemory(mem, channel, items, { strict: true });
  return { memory, hidden, scoped: true };
}

/**
 * The community a relay URL serves, as a readable label. Shared with the
 * server (buzz-hook) so both sides derive the same "Buzz: <label>" project
 * name from a connection's relay URL.
 */
export function communityLabelFromRelayUrl(relayUrl: string): string {
  const host = (() => { try { return new URL(relayUrl.replace(/^ws/, "http")).host; } catch { return relayUrl; } })();
  return host.replace(/\.communities\.buzz\.xyz$/i, "");
}

const DEFAULT_GW_BASE_URL = "https://groupwisdom-v1-production.up.railway.app/v1";
const DEFAULT_CURSOR_FILE = ".buzz-cursor.json";
const RECENT_LIMIT = 15;         // event ids kept per project for source citation
const MAX_CITATIONS = 4;
// The API debounces ingest ~3s then runs a two-pass engine, so wisdom lands at an
// unpredictable moment. Poll several times instead of once, deduped by wisdom id.
const POLL_SCHEDULE_MS = [5000, 12000, 25000, 45000];
const PROCESSED_ID_CAP = 500;    // bounded memory of event ids, for restart-safe dedup
const POSTED_CARD_CAP = 300;     // event id → wisdom id, enough to cover any card still being reacted to

/**
 * Reaction events. NIP-25 kind 7 is the standard, and Buzz is pre-1.0 with
 * reaction handling that has already changed once, so anything referencing one
 * of our cards from an unexpected kind is logged rather than dropped silently.
 * That way production tells us the truth instead of us guessing it.
 */
const REACTION_KINDS = [7];
const DELETE_KIND = 5;           // NIP-09: how an un-react arrives

/** Emoji to verdict. Anything else is a reaction we simply do not read. */
const VERDICT_FOR_EMOJI: Record<string, "helpful" | "wrong" | "late"> = {
  "\u{1F44D}": "helpful",   // 👍
  "+": "helpful",            // NIP-25 shorthand
  "\u{1F44E}": "wrong",     // 👎
  "-": "wrong",
  "\u{1F550}": "late",      // 🕐
  "\u{23F0}": "late",       // ⏰
};

/** Reactions arrive with variation selectors and skin tones; strip them before matching. */
function verdictForReaction(content: string): "helpful" | "wrong" | "late" | null {
  const bare = String(content ?? "").trim()
    .replace(/[\u{FE0F}\u{FE0E}]/gu, "")            // variation selectors
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "");        // skin tone modifiers
  return VERDICT_FOR_EMOJI[bare] ?? null;
}

type Wisdom = {
  id: string; kind: string; title: string; body: string;
  confidence?: string | null; caveat?: string | null; do_next?: string | null; missing_voice?: string | null;
  /** The channel this was drawn for. Null means it was not drawn for one. */
  channel?: string | null;
};

// ── Key handling ────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length !== 64) throw new Error("private key hex must be 32 bytes (64 hex chars)");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toSecretKey(key: string): Uint8Array {
  if (key.startsWith("nsec")) {
    const { type, data } = nip19decode(key);
    if (type !== "nsec") throw new Error("expected an nsec key");
    return data as Uint8Array;
  }
  return hexToBytes(key.trim());
}

// ── Adapter ─────────────────────────────────────────────────────────────────

export function startBuzzAdapter(cfg: BuzzConfig): { stop: () => void } {
  const log = cfg.onLog ?? ((m: string) => console.log("[buzz]", m));
  const sk = toSecretKey(cfg.privateKey);
  const pk = getPublicKey(sk);
  const gwBase = cfg.groupwisdomBaseUrl ?? DEFAULT_GW_BASE_URL;
  log(`agent pubkey ${pk.slice(0, 12)}… connecting to ${cfg.relayUrl}`);
  log(`GroupWisdom API: ${gwBase}`);

  // Fail fast on a bad attestation rather than surfacing it as an opaque auth rejection.
  if (cfg.authTag) {
    const owner = verifyAuthTag(cfg.authTag, pk);   // throws with a specific reason
    log(`NIP-AA attestation valid — authorized by owner ${owner.slice(0, 12)}…`);
  }

  // ── GroupWisdom HTTP client — real API calls, your key, your account ────────
  async function gwFetch(path: string, init?: RequestInit): Promise<any> {
    const res = await fetch(gwBase + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${cfg.groupwisdomApiKey}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`GroupWisdom API ${res.status}: ${text}`);
    return json;
  }

  const channelNames = new Map<string, string>();           // channel uuid → human name (from kind:39000)
  const profileNames = new Map<string, string>();           // pubkey → display name (from kind:0)
  const profileRequested = new Set<string>();               // pubkeys we've already asked about
  const mentionNames = new Map<string, string>();           // pubkey → name learned from an @mention
  const postedCards = new Map<string, string>();            // our posted event id → the wisdom id it carried
  const reactionOwners = new Map<string, string>();         // reaction event id → the wisdom it judged
  const mentionedInChannel = new Map<string, Set<string>>();// channel → names people have @mentioned
  const unnamedAuthors = new Map<string, Set<string>>();    // channel → posters we still have no name for
  const seenInsightIds = new Map<string, Set<string>>();    // projectId → wisdom that already existed when we connected
  const postedByChannel = new Map<string, Set<string>>();   // projectId::channel → wisdom already posted there
  const recentEventIds = new Map<string, string[]>();       // channel → recent nostr event ids (for #e citations)
  const pollTimers = new Map<string, NodeJS.Timeout[]>();   // projectId::channel → pending poll timers
  const watched = new Set<string>();

  let ws: WebSocket | null = null;
  let authPending: string | null = null;
  let authed = false;      // greetings only post on an authenticated socket
  let stopped = false;
  let backoff = 1000;
  const startedAt = Math.floor(Date.now() / 1000);

  // ── Cursor: so a restart never loses messages posted while we were down ─────
  // Shape: { channels: { <uuid>: <last created_at> }, processed: [<event id>, …],
  //          greeted: [<channel uuid>, …], over_budget_notified: boolean,
  //          names: { <pubkey>: <name learned from a mention> },
  //          cards: [[<posted event id>, <wisdom id>], …] }
  const cursorPath = cfg.cursorFile ?? DEFAULT_CURSOR_FILE;
  const store = cfg.cursorStore ?? {
    load: () => { try { return readFileSync(cursorPath, "utf8"); } catch { return null; } },
    save: (state: string) => writeFileSync(cursorPath, state),
  };
  let cursors: Record<string, number> = {};
  let processedIds: string[] = [];
  let greetedList: string[] = [];
  let notifiedOverBudget = false;
  try {
    const saved = JSON.parse(store.load() ?? "");
    cursors = saved.channels ?? {};
    processedIds = saved.processed ?? [];
    greetedList = saved.greeted ?? [];
    notifiedOverBudget = Boolean(saved.over_budget_notified);
    // Learned names must survive a restart: on reconnect we only replay messages
    // since the cursor, so the mention that taught us a name may never be seen again.
    for (const [p, n] of Object.entries(saved.names ?? {})) mentionNames.set(p, String(n));
    // Which posted event was which finding. Without this a 👍 arrives as a
    // reaction to an event id we cannot connect to anything.
    for (const [eventId, wisdomId] of (saved.cards ?? [])) postedCards.set(String(eventId), String(wisdomId));
    const n = Object.keys(cursors).length;
    if (n) log(`resuming from cursor: ${n} channel(s) tracked`);
  } catch { /* first run — no cursor yet */ }
  const processedSet = new Set(processedIds);
  const greeted = new Set(greetedList);

  function saveCursor() {
    try {
      store.save(JSON.stringify({
        channels: cursors, processed: processedIds,
        greeted: [...greeted], over_budget_notified: notifiedOverBudget,
        names: Object.fromEntries(mentionNames),
        cards: [...postedCards].slice(-POSTED_CARD_CAP),
      }));
    } catch (e) {
      log(`cursor save failed: ${(e as Error).message}`);
    }
  }

  /** Oldest message time we still care about for a channel. */
  function floorFor(channel: string): number {
    // Known channel → resume exactly where we left off. New channel → start from now,
    // so first contact doesn't replay an entire history.
    return cursors[channel] ?? startedAt;
  }

  function markProcessed(channel: string, ev: Event) {
    cursors[channel] = Math.max(cursors[channel] ?? 0, ev.created_at);
    processedIds.push(ev.id);
    processedSet.add(ev.id);
    if (processedIds.length > PROCESSED_ID_CAP) {
      const dropped = processedIds.splice(0, processedIds.length - PROCESSED_ID_CAP);
      for (const id of dropped) processedSet.delete(id);
    }
    saveCursor();
  }

  // Get-or-create the GroupWisdom project for a Buzz channel — real API calls, deduped.
  /**
   * The community this connection serves, as a readable label. Projects are keyed
   * on this rather than on channel name: two communities both having a "general"
   * channel would otherwise share one project and blend their content together.
   */
  const communityLabel = communityLabelFromRelayUrl(cfg.relayUrl);

  let communityProject: Promise<string> | null = null;

  /** One GroupWisdom project for the whole community. */
  function ensureProject(): Promise<string> {
    if (communityProject) return communityProject;
    const name = `Buzz: ${communityLabel}`;
    communityProject = (async () => {
      const projects = await gwFetch("/projects");
      const found = projects.find((p: any) => p.name === name);
      const project = found ?? await gwFetch("/projects", { method: "POST", body: JSON.stringify({ name }) });

      // Pre-seed seen ids with anything already there (e.g. from a prior run) so we
      // never re-post old wisdom as if it were new.
      const existingWisdom = await gwFetch(`/projects/${project.id}/insights?format=full&limit=50`).catch(() => ({ data: [] }));
      seenInsightIds.set(project.id, new Set((existingWisdom.data ?? []).map((w: Wisdom) => w.id)));

      log(`project ready: "${name}" → ${project.id.slice(0, 8)}…`);
      return project.id;
    })();
    return communityProject;
  }

  function pushRecent(channel: string, eventId: string) {
    const arr = recentEventIds.get(channel) ?? [];
    arr.unshift(eventId);
    recentEventIds.set(channel, arr.slice(0, RECENT_LIMIT));
  }

  function send(msg: unknown[]) {
    ws?.send(JSON.stringify(msg));
  }

  const allowlist = new Set(cfg.channels ?? []);
  const isAllowed = (channel: string) => allowlist.size === 0 || allowlist.has(channel);

  function reportDiscovered() {
    if (!cfg.onChannelsDiscovered) return;
    cfg.onChannelsDiscovered([...channelNames].map(([id, name]) => ({ id, name })));
  }

  function subscribeChannel(channel: string) {
    if (!isAllowed(channel)) return;   // outside the allowlist: never watched or billed
    if (watched.has(channel)) return;
    watched.add(channel);
    // No project is created here — ensureProject() runs lazily on the first real message
    // (inside handleMessage, which is the single dry-run gate). Watching a channel must
    // never touch the GroupWisdom API on its own.
    // `since` the cursor: on a restart the relay replays anything we missed while
    // down, so no message is skipped; on first contact this is "now".
    send(["REQ", `msgs:${channel}`, { kinds: [9], "#h": [channel], since: floorFor(channel) }]);
    log(`watching channel ${channelNames.get(channel) ?? channel.slice(0, 8)}`);
    greetChannel(channel);
  }

  // ── Hello on join ────────────────────────────────────────────────────────────
  // A brand-new channel has an empty memory and needs two contributors before
  // the engine can ever speak, so the first wisdom may be days away. Without
  // this, that silence reads as broken at the exact moment someone is watching
  // closest. One message, once per channel ever (persisted in the cursor), and
  // it doubles as disclosure that the agent is reading.
  /**
   * The intro, posted once when the agent joins a channel.
   *
   * The specified text ends with three offers: asking under a card for its
   * sources, 👍/👎 reactions, and @wisdom feedback. None of those are built
   * yet, and an introduction that opens with promises the agent cannot keep
   * costs more trust than the sentences would have earned. Each line below is
   * uncommented the day its feature lands, at which point this matches the
   * spec verbatim.
   */
  const HELLO =
    "👋 I'm Wisdom Agent. I read everything in this channel so nothing important " +
    "slips by. Most of the time I stay quiet. When your messages add up to " +
    "something worth knowing, a clash, a gap, a deadline at risk, I post it here.";
    // + " Ask under any of my posts and I'll show exactly which messages it came from."   ← with source citations
    // + " A 👍 or 👎 tells me how I'm doing,"                                             ← with reaction feedback
    // + " and @wisdom feedback sends a note to the team behind me."                       ← with the feedback command

  function greetChannel(channel: string) {
    if (!authed || cfg.dryRun) return;   // pre-auth posts are rejected; dry-run never posts
    if (greeted.has(channel)) return;
    greeted.add(channel);
    saveCursor();                        // before posting: a crash must not re-greet forever
    postNotice(channel, HELLO);
    log(`greeted channel ${channelNames.get(channel) ?? channel.slice(0, 8)}`);
  }

  /** A plain agent message into a channel — carries the gw marker so we never re-ingest it. */
  function postNotice(channel: string, text: string, replyTo?: string) {
    const tmpl: EventTemplate = {
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      content: text,
      // A reply to a command threads under it, so an answer never lands as a
      // loose message in the channel.
      tags: [["h", channel], ...(replyTo ? [["e", replyTo]] : []), ["gw", "1"]],
    };
    send(["EVENT", finalizeEvent(tmpl, sk)]);
  }

  // Names make wisdom readable: without this, findings are attributed to raw
  // pubkey prefixes ("411dfdb2's checkout metrics") instead of people.
  function subscribeProfiles() {
    send(["REQ", "profiles", { kinds: [0] }]);
  }

  /**
   * Reactions and un-reactions. The stock mention-driven harness wakes only on
   * mentions, which would miss every one of these, so we take the stream.
   * `since` bounds the replay to this session: verdicts already recorded do not
   * need re-reading, and the pairing map only covers recent cards anyway.
   */
  function subscribeReactions() {
    send(["REQ", "reactions", { kinds: [...REACTION_KINDS, DELETE_KIND], since: startedAt }]);
  }

  /**
   * Ask for an author's profile and wait briefly for it.
   *
   * Firing the request and reading the name in the same tick meant the first
   * message from anyone was always attributed to a pubkey prefix — the reply had
   * not arrived yet. That is exactly when it matters, because someone who just
   * joined is the person you have never seen before.
   */
  function requestProfile(pubkey: string, waitMs = 2500): Promise<void> {
    if (profileNames.has(pubkey)) return Promise.resolve();
    if (!profileRequested.has(pubkey)) {
      profileRequested.add(pubkey);
      send(["REQ", `prof:${pubkey.slice(0, 8)}`, { kinds: [0], authors: [pubkey] }]);
    }
    return new Promise(resolve => {
      const started = Date.now();
      const tick = () => {
        if (profileNames.has(pubkey) || Date.now() - started > waitMs) return resolve();
        setTimeout(tick, 120);
      };
      tick();
    });
  }

  /** Display name for a contributor, falling back to a short pubkey. */
  function contributorName(pubkey: string): string {
    return profileNames.get(pubkey) ?? mentionNames.get(pubkey) ?? pubkey.slice(0, 8);
  }

  // ── Learning an agent's name ─────────────────────────────────────────────────
  // Agents often never publish a kind:0 profile, so profile lookup returns
  // nothing and wisdom ends up attributing real work to "51d3b66e", which reads
  // as a bug and undoes the whole point of handing over a teammate's finding.
  // The name is right there in the room though: people write "@Marketer …". Both
  // routes below only fire when the pairing is unambiguous. Guessing wrong would
  // put one contributor's work in another's mouth, which is worse than a hex
  // prefix, so when it is ambiguous we learn nothing.

  function rememberName(pubkey: string, name: string) {
    if (pubkey === pk) return;                       // never rename ourselves
    if (profileNames.has(pubkey)) return;            // a real kind:0 profile always wins
    if (mentionNames.get(pubkey) === name) return;
    mentionNames.set(pubkey, name);
    for (const set of unnamedAuthors.values()) set.delete(pubkey);
    log(`learned name for ${pubkey.slice(0, 8)}…: ${name}`);
    saveCursor();

    // Anything this contributor posted before we knew them is filed under the
    // pubkey prefix, in items and in the engine's memory. Left alone, wisdom
    // cites both names in one sentence as if they were two people.
    if (!communityProject) return;                      // nothing ingested yet, nothing to rename
    communityProject
      .then(projectId => gwFetch(`/projects/${projectId}/rename-contributor`, {
        method: "POST",
        body: JSON.stringify({ from: pubkey.slice(0, 8), to: name }),
      }))
      .then((r: any) => {
        if (r?.members || r?.memoryUpdated) log(`renamed past work by ${pubkey.slice(0, 8)}… to ${name}`);
      })
      .catch(e => log(`rename failed for ${pubkey.slice(0, 8)}…: ${(e as Error).message}`));
  }

  /**
   * Route 2: within one channel, when exactly one name has ever been mentioned
   * and exactly one poster is still nameless, they are each other. Anything less
   * clear-cut is left alone.
   */
  function resolveByElimination(channel: string) {
    const names = [...(mentionedInChannel.get(channel) ?? [])]
      .filter(n => ![...profileNames.values(), ...mentionNames.values()].includes(n));
    const unnamed = [...(unnamedAuthors.get(channel) ?? [])]
      .filter(p => !profileNames.has(p) && !mentionNames.has(p));
    if (names.length === 1 && unnamed.length === 1) rememberName(unnamed[0], names[0]);
  }

  function learnNames(ev: Event) {
    const channel = ev.tags.find(t => t[0] === "h")?.[1];
    if (!channel) return;

    // Anyone who posts without a name yet is a candidate for elimination.
    if (ev.pubkey !== pk && !profileNames.has(ev.pubkey) && !mentionNames.has(ev.pubkey)) {
      if (!unnamedAuthors.has(channel)) unnamedAuthors.set(channel, new Set());
      unnamedAuthors.get(channel)!.add(ev.pubkey);
    }

    const mentions = parseMentions(ev.content ?? "");
    if (mentions.length) {
      if (!mentionedInChannel.has(channel)) mentionedInChannel.set(channel, new Set());
      for (const n of mentions) mentionedInChannel.get(channel)!.add(n);
    }

    // Route 1: one mention, one tagged pubkey — an exact pairing, no inference.
    const tagged = [...new Set(ev.tags.filter(t => t[0] === "p" && t[1]).map(t => t[1]!))]
      .filter(p => p !== ev.pubkey && p !== pk);
    if (mentions.length === 1 && tagged.length === 1) rememberName(tagged[0], mentions[0]);

    resolveByElimination(channel);
  }

  function subscribeMembership() {
    // Learn when we're added to a NEW channel going forward (relay-signed, filtered to our pubkey).
    send(["REQ", "membership", { kinds: [44100], "#p": [pk] }]);
  }

  // One-shot: discover every channel this identity can already see (open + member-of-private).
  // kind:44100 alone misses channels we created ourselves — the relay doesn't emit a
  // membership-added event for the creator — so this is the reliable initial discovery path.
  function discoverChannels() {
    send(["REQ", "discover", { kinds: [39000] }]);
  }

  let profilePublished = false;
  function publishProfile() {
    if (profilePublished) return;
    profilePublished = true;
    const tmpl: EventTemplate = {
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      content: JSON.stringify({
        name: "Wisdom Agent",
        display_name: "Wisdom Agent",
        about: "Reads what the channel has found and hands each member what the group already knows.",
      }),
      tags: [],
    };
    send(["EVENT", finalizeEvent(tmpl, sk)]);
  }

  // ── Step 4: post wisdom back into the channel, citing sources via #e ──────────

  function postWisdom(channel: string, wisdom: Wisdom, triggerEventId: string) {
    const recent = recentEventIds.get(channel) ?? [];
    const sources = [triggerEventId, ...recent.filter(id => id !== triggerEventId)].slice(0, MAX_CITATIONS);
    const tmpl: EventTemplate = {
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      // A mark, a headline, a body. Nothing else: no labels, no confidence, no
      // sources, no footer. Those stay complete in the API object and the
      // dashboard, where they belong. do_next in particular stays off the card,
      // because appending it turned every finding into a chore.
      content: formatCard(wisdom.kind, wisdom.title, wisdom.body),
      tags: [
        ["h", channel],
        ...sources.map(id => ["e", id]),
        ["t", wisdom.kind],                  // the wisdom kind (convergence, opportunity, …)
        ["gw", "1"],                         // marker so we never re-ingest our own wisdom
      ],
    };
    if (cfg.dryRun) {
      log(`[dry-run] would post ${wisdom.kind} → ${channel.slice(0, 8)}… citing ${sources.length} source(s): ${wisdom.title}`);
      return;
    }
    const signed = finalizeEvent(tmpl, sk);
    send(["EVENT", signed]);
    // Remember which event carried which finding. A reaction arrives referencing
    // the event id, and without this pairing there is nothing to attach it to.
    postedCards.set(signed.id, wisdom.id);
    if (postedCards.size > POSTED_CARD_CAP * 2) {
      for (const k of [...postedCards.keys()].slice(0, postedCards.size - POSTED_CARD_CAP)) postedCards.delete(k);
    }
    saveCursor();
    log(`posted ${wisdom.kind} → ${channel.slice(0, 8)}… citing ${sources.length} source(s)`);
  }

  // ── Step 3 (delayed): poll the real API for wisdom that resulted from recent ingests ──
  function schedulePoll(projectId: string, triggerEventId: string, channel: string) {
    // Per channel, not per project. Both of these used to be keyed by project,
    // which meant a message in one channel cancelled another channel's pending
    // poll and then claimed its card — posting it into the wrong room.
    const key = `${projectId}::${channel}`;
    // Restart the sequence on each new message in this channel — wisdom is deduped
    // by id, so overlapping polls are harmless, and several attempts mean slow
    // engine runs still get delivered rather than silently dropped.
    for (const t of pollTimers.get(key) ?? []) clearTimeout(t);

    const pollOnce = async () => {
      try {
        const res = await gwFetch(`/projects/${projectId}/insights?format=full&limit=20`);
        const preexisting = seenInsightIds.get(projectId) ?? new Set<string>();
        const posted = postedByChannel.get(key) ?? new Set<string>();
        const fresh: Wisdom[] = (res.data ?? [])
          .filter((w: Wisdom) => !preexisting.has(w.id) && !posted.has(w.id))
          .filter((w: Wisdom) => postableInChannel(w, channel));
        if (fresh.length) log(`API returned ${fresh.length} new wisdom for ${channelNames.get(channel) ?? channel.slice(0, 8)}`);
        for (const w of fresh) { posted.add(w.id); postWisdom(channel, w, triggerEventId); }
        postedByChannel.set(key, posted);
      } catch (e) {
        log(`poll error: ${(e as Error).message}`);
      }
    };

    pollTimers.set(key, POLL_SCHEDULE_MS.map(ms => setTimeout(pollOnce, ms)));
  }

  // ── Steps 1 & 2: map an incoming Buzz message to a real GroupWisdom ingest call ──
  async function handleMessage(ev: Event) {
    // Only two messages are ever skipped: our own wisdom (marker tag, not pubkey — the
    // agent may share an identity with a human), and anything already processed.
    // EVERY other kind:9 is ingested, whether it came from a person or another agent.
    if (ev.tags.some(t => t[0] === "gw")) return;
    // Names are learned from every message, including ones already ingested: a
    // mention that arrived before we knew the agent still teaches us its name.
    learnNames(ev);
    if (processedSet.has(ev.id)) return;                  // already ingested (restart replay)
    const channel = ev.tags.find(t => t[0] === "h")?.[1];
    if (!channel) return;
    if (!isAllowed(channel)) return;                      // outside the allowlist
    if (ev.created_at < floorFor(channel)) return;        // predates our first sight of this channel
    const content = ev.content ?? "";

    // A command is addressed to the agent, not a contribution to the group.
    // Intercepting here also saves the model call the memory gate would spend
    // concluding exactly that.
    if (await handleCommand(ev, channel)) { markProcessed(channel, ev); return; }

    if (cfg.dryRun) {
      log(`[dry-run] would ingest into ${channel.slice(0, 8)}… from ${ev.pubkey.slice(0, 8)}… (${content.length} chars)`);
      return;
    }

    try {
      // Resolve who this is before ingesting, so the finding names a person
      // rather than a pubkey. Falls back to the prefix if they have no profile.
      await requestProfile(ev.pubkey);
      const projectId = await ensureProject();
      pushRecent(channel, ev.id);
      await gwFetch(`/projects/${projectId}/ingest`, {
        method: "POST",
        body: JSON.stringify({
          title: truncate(content, 60) || "(message)",
          content,
          type: "note",
          contributed_by: contributorName(ev.pubkey),
          channel,     // provenance, so a per-channel answer stays inside its channel
        }),
      });
      markProcessed(channel, ev);   // only after the API accepted it, so a failure retries on restart
      // Names and sizes only — message content must never reach the host's logs.
      log(`ingested → GroupWisdom | ${channelNames.get(channel) ?? channel.slice(0, 8)} | from ${contributorName(ev.pubkey)} (${content.length} chars)`);
      schedulePoll(projectId, ev.id, channel);
      checkBudgetNotice(channel);
    } catch (e) {
      log(`ingest failed for ${channel.slice(0, 8)}…: ${(e as Error).message}`);
    }
  }

  // ── Budget notice ────────────────────────────────────────────────────────────
  // When the account's included analysis runs out, the engine goes quiet, which
  // from inside Buzz is indistinguishable from "nothing worth saying". Say so
  // once in the channel where it happened, so the silence has a name. Throttled
  // to one usage check every few minutes, persisted so a redeploy can't re-post.
  const BUDGET_NOTICE =
    "A note from the Wisdom Agent: this community's included analysis is used " +
    "up, so I have stopped reading new messages for now. Whoever connected me " +
    "can see usage on the GroupWisdom Buzz page.";
  let lastUsageCheckAt = 0;

  async function checkBudgetNotice(channel: string) {
    if (Date.now() - lastUsageCheckAt < 5 * 60_000) return;
    lastUsageCheckAt = Date.now();
    try {
      const u = await gwFetch("/usage");
      if (u?.limit_reached && !notifiedOverBudget) {
        notifiedOverBudget = true;
        saveCursor();               // before posting, so a crash can't repeat the notice
        postNotice(channel, BUDGET_NOTICE);
        log("posted over-budget notice");
      } else if (u && !u.limit_reached && notifiedOverBudget) {
        notifiedOverBudget = false; // budget was raised — clear so a future cap can notify again
        saveCursor();
      }
    } catch { /* best effort — never let a usage check break ingestion */ }
  }

  // ── Commands ─────────────────────────────────────────────────────────────────
  // Answered as ordinary replies, with no mark: a mark means the engine found
  // something, and a command response is the agent talking, not thinking.

  /**
   * What the agent currently knows, in plain words. The team's best debugging
   * tool, and the honest answer to "has it actually understood us?".
   *
   * Facts quote the message they came from rather than printing an id, so the
   * output can be checked against the channel by eye.
   */
  async function commandMemory(channel: string, replyTo: string) {
    const projectId = await ensureProject();
    const [full, items] = await Promise.all([
      gwFetch(`/projects/${projectId}/memory`).then((r: any) => r?.memory ?? null).catch(() => null),
      gwFetch(`/projects/${projectId}/items?limit=200`).then((r: any) => r?.data ?? []).catch(() => []),
    ]);

    if (!full || !(full.facts?.length || full.decisions?.length || full.open_questions?.length)) {
      postNotice(channel, "I have not built up anything yet. Once people share work here I will have something to show.", replyTo);
      return;
    }

    // Answer about this channel, not about everything we watch. See scopeMemoryToChannel.
    const { memory: mem, hidden, scoped } =
      scopeMemoryToChannel(full, channel, items, { multiChannel: watched.size > 1 });

    if (!(mem.facts?.length || mem.decisions?.length)) {
      postNotice(channel, "Nothing yet from this channel. I keep what I learn to the channel it came from, so share some work here and I will have something to show.", replyTo);
      return;
    }

    // Short source ids map back to the message they came from, so a fact can
    // quote its origin instead of naming an id nobody can look up.
    const byShortId = new Map<string, any>();
    for (const it of items) byShortId.set(String(it.id).slice(0, 8), it);
    const quoteFor = (sources: string[] = [], len = 45) => {
      for (const sid of sources) {
        const it = byShortId.get(sid);
        const text = String(it?.content ?? it?.title ?? "").replace(/\s+/g, " ").trim();
        if (text) return truncate(text, len) + (text.length > len ? "…" : "");
      }
      return "";
    };

    // A chat message, not a report. Long enough to be checkable, short enough
    // that someone actually reads it: an earlier draft ran to 3,400 characters
    // and 31 lines, which nobody would.
    const FACT_LINE = 110, QUOTE_LEN = 45, MAX_FACTS = 8, MAX_QUESTIONS = 5;

    /** A contributor we never learned a name for is a hex prefix. Printing it
     *  would put a raw id in the text, so it is simply left off. */
    const namePart = (by: string) =>
      (by && !/^[0-9a-f]{8,}$/i.test(by.trim())) ? ` (${by})` : "";

    const lines: string[] = [scoped ? "Here is what I know from this channel." : "Here is what I know so far."];
    let lastQuote = "";

    const facts = mem.facts ?? [];
    if (facts.length) {
      lines.push("", "What I have established:");
      for (const f of facts.slice(-MAX_FACTS).reverse()) {
        const fact = truncate(String(f.fact ?? "").trim(), FACT_LINE) +
          (String(f.fact ?? "").length > FACT_LINE ? "…" : "");
        const q = quoteFor(f.sources, QUOTE_LEN);
        // Several facts often come from one long message; repeating the same
        // quote line after line is noise, so it is shown once.
        const quote = q && q !== lastQuote ? ` — from “${q}”` : "";
        if (q) lastQuote = q;
        lines.push(`• ${fact}${namePart(f.by)}${quote}`);
      }
      if (facts.length > MAX_FACTS) lines.push(`…and ${facts.length - MAX_FACTS} more I am still holding.`);
    }

    const decisions = mem.decisions ?? [];
    if (decisions.length) {
      lines.push("", "What you have decided:");
      for (const d of decisions.slice(-4).reverse()) {
        lines.push(`• ${truncate(String(d.decision ?? "").trim(), FACT_LINE)}`);
      }
    }

    const questions = mem.open_questions ?? [];
    if (questions.length) {
      lines.push("", "Still open:");
      for (const q of questions.slice(0, MAX_QUESTIONS)) lines.push(`• ${truncate(String(q).trim(), FACT_LINE)}`);
      if (questions.length > MAX_QUESTIONS) lines.push(`…and ${questions.length - MAX_QUESTIONS} more.`);
    }

    // The count of findings already spoken is community-wide, so it would
    // overstate a scoped answer. Left off rather than reported wrong.
    const spoken = scoped ? 0 : (mem.active_wisdom?.length ?? 0);
    if (spoken) lines.push("", `I have shared ${spoken} finding${spoken === 1 ? "" : "s"} from this, and will not repeat ${spoken === 1 ? "it" : "them"}.`);

    if (scoped && hidden) lines.push("", "I also hold notes from other channels here. Those stay in the channel they came from.");

    postNotice(channel, lines.join("\n"), replyTo);
    log(`answered memory in ${channelNames.get(channel) ?? channel.slice(0, 8)}${scoped ? ` (scoped, ${hidden} withheld)` : ""}`);
  }

  /** Returns true when the message was a command, so it is not also ingested. */
  async function handleCommand(ev: Event, channel: string): Promise<boolean> {
    const taggedUs = ev.tags.some(t => t[0] === "p" && t[1] === pk);
    const cmd = parseCommand(ev.content ?? "", { taggedUs });
    if (!cmd) return false;

    if (cfg.dryRun) { log(`[dry-run] would answer command: ${cmd.name}`); return true; }
    try {
      if (cmd.name === "memory") await commandMemory(channel, ev.id);
    } catch (e) {
      log(`command ${cmd.name} failed: ${(e as Error).message}`);
      postNotice(channel, "Something went wrong reading that back. Try again in a moment.", ev.id);
    }
    return true;
  }

  // ── Reactions become verdicts ────────────────────────────────────────────────
  // The only signal that tells us whether the engine is any good rather than
  // merely quiet. Nothing here is ever posted back into the channel: the
  // reaction is already public, what we conclude from it is not.

  async function handleReaction(ev: Event) {
    // A reaction points at what it judges with `e` tags. Ours is whichever one
    // we recognise as a card we posted.
    const targets = ev.tags.filter(t => t[0] === "e" && t[1]).map(t => t[1]!);
    const cardEventId = targets.find(id => postedCards.has(id));
    if (!cardEventId) return;                       // a reaction to an ordinary message

    const wisdomId = postedCards.get(cardEventId)!;
    const verdict = verdictForReaction(ev.content);
    if (!verdict) return;                           // a 🎉 is not a verdict, and that is fine

    if (cfg.dryRun) { log(`[dry-run] would record ${verdict} on ${wisdomId.slice(0, 8)}…`); return; }

    try {
      await gwFetch(`/wisdom/${wisdomId}/feedback`, {
        method: "POST",
        body: JSON.stringify({ verdict, member: ev.pubkey, source_event_id: ev.id }),
      });
      reactionOwners.set(ev.id, wisdomId);
      log(`feedback: ${verdict} on ${wisdomId.slice(0, 8)}… from ${contributorName(ev.pubkey)}`);
    } catch (e) {
      log(`feedback failed for ${wisdomId.slice(0, 8)}…: ${(e as Error).message}`);
    }
  }

  /** An un-react is a deletion of the reaction event, which withdraws the verdict. */
  async function handleReactionDelete(ev: Event) {
    const removed = ev.tags.filter(t => t[0] === "e" && t[1]).map(t => t[1]!)
      .filter(id => reactionOwners.has(id));
    if (!removed.length || cfg.dryRun) return;
    for (const reactionId of removed) {
      try {
        await gwFetch(`/wisdom/feedback/${reactionId}`, { method: "DELETE" });
        reactionOwners.delete(reactionId);
        log(`feedback withdrawn (reaction removed)`);
      } catch (e) {
        log(`withdraw failed: ${(e as Error).message}`);
      }
    }
  }

  function handleFrame(data: WebSocket.RawData) {
    let frame: unknown[];
    try { frame = JSON.parse(data.toString()); } catch { return; }
    const [type] = frame as [string, ...unknown[]];

    switch (type) {
      case "AUTH": {
        // NIP-42 proactive challenge → sign a kind:22242 auth event and reply.
        // If we hold a NIP-OA attestation, attach it: the relay then grants access
        // via the owner's membership (NIP-AA) rather than requiring us to be enrolled.
        const challenge = frame[1] as string;
        const authTmpl = makeAuthEvent(cfg.relayUrl, challenge);
        if (cfg.authTag) authTmpl.tags = [...authTmpl.tags, cfg.authTag];
        const signed = finalizeEvent(authTmpl, sk);
        authPending = signed.id;
        send(["AUTH", signed]);
        log(cfg.authTag
          ? `authenticating (NIP-42 + NIP-AA, authorized by ${cfg.authTag[1].slice(0, 8)}…)`
          : "authenticating (NIP-42)…");
        break;
      }
      case "OK": {
        const [, id, ok, msg] = frame as [string, string, boolean, string];
        if (id === authPending) {
          authPending = null;
          if (ok) {
            log("authenticated");
            authed = true;            // before subscribeAll, so greetings can post
            watched.clear();          // pre-auth subs were rejected; re-send them
            publishProfile();         // must be post-auth or the relay rejects it
            subscribeAll();
          }
          else log(`auth rejected: ${msg}`);
        }
        break;
      }
      case "EVENT": {
        const ev = frame[2] as Event;
        if (ev.kind === 9) handleMessage(ev).catch(e => log(`handleMessage error: ${e.message}`));
        else if (REACTION_KINDS.includes(ev.kind)) handleReaction(ev).catch(e => log(`handleReaction error: ${e.message}`));
        else if (ev.kind === DELETE_KIND) handleReactionDelete(ev).catch(e => log(`handleReactionDelete error: ${e.message}`));
        else if (ev.kind === 44100) {
          const channel = ev.tags.find(t => t[0] === "h")?.[1];
          if (channel) subscribeChannel(channel);
        } else if (ev.kind === 0) {
          try {
            const meta = JSON.parse(ev.content || "{}");
            const name = meta.display_name || meta.name;
            if (name) profileNames.set(ev.pubkey, String(name).slice(0, 40));
          } catch { /* malformed profile — keep the pubkey fallback */ }
        } else if (ev.tags.some(t => t[0] === "e" && t[1] && postedCards.has(t[1]))) {
          // Something referenced one of our cards from a kind we do not handle.
          // Buzz is pre-1.0 and its reaction handling has changed before, so
          // this is how production tells us the real kind rather than us guessing.
          log(`unhandled kind ${ev.kind} references one of our cards (content: ${JSON.stringify(String(ev.content ?? "").slice(0, 16))})`);
        } else if (ev.kind === 39000) {
          // Discovery: every channel this identity can see, including ones it created
          // itself (which never get a kind:44100 membership event).
          const channel = ev.tags.find(t => t[0] === "d")?.[1];
          const name = ev.tags.find(t => t[0] === "name")?.[1];
          if (channel) {
            // Learn every channel's name even when restricted, so the setup page
            // can list them as choices; subscribeChannel enforces the allowlist.
            channelNames.set(channel, name ?? channel.slice(0, 8));
            reportDiscovered();
            subscribeChannel(channel);
          }
        }
        break;
      }
      case "CLOSED": {
        const [, subId, reason] = frame as [string, string, string];
        // Auth-gated subscription — retry after we've authed.
        if (/auth/i.test(reason)) log(`sub ${subId} needs auth: ${reason}`);
        break;
      }
      case "NOTICE":
        log(`notice: ${frame[1]}`);
        break;
    }
  }

  function subscribeAll() {
    subscribeProfiles();
    subscribeReactions();
    subscribeMembership();
    discoverChannels();                                       // finds every channel, incl. self-created ones
    for (const c of cfg.channels ?? []) subscribeChannel(c);   // optional explicit override/restriction
  }

  function connect() {
    if (stopped) return;
    ws = new WebSocket(cfg.relayUrl);
    ws.on("open", () => {
      log("connected");
      backoff = 1000;
      // Send subscriptions immediately; if the relay requires auth it will send AUTH and
      // CLOSED, and we re-subscribe from the OK handler after authenticating.
      subscribeAll();
    });
    ws.on("message", handleFrame);
    ws.on("close", () => { if (!stopped) reconnect(); });
    ws.on("error", (e) => log(`ws error: ${(e as Error).message}`));
  }

  function reconnect() {
    authed = false;
    watched.clear();
    profileRequested.clear();   // re-ask; profiles may have changed while we were away
    profilePublished = false;
    log(`reconnecting in ${backoff}ms`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  }

  connect();

  return {
    stop() {
      stopped = true;
      ws?.close();
      log("stopped");
    },
  };
}
