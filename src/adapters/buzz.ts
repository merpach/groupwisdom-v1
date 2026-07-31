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

const DEFAULT_GW_BASE_URL = "https://groupwisdom-v1-production.up.railway.app/v1";
const DEFAULT_CURSOR_FILE = ".buzz-cursor.json";
const RECENT_LIMIT = 15;         // event ids kept per project for source citation
const MAX_CITATIONS = 4;
// The API debounces ingest ~3s then runs a two-pass engine, so wisdom lands at an
// unpredictable moment. Poll several times instead of once, deduped by wisdom id.
const POLL_SCHEDULE_MS = [5000, 12000, 25000, 45000];
const PROCESSED_ID_CAP = 500;    // bounded memory of event ids, for restart-safe dedup

type Wisdom = {
  id: string; kind: string; title: string; body: string;
  confidence?: string | null; caveat?: string | null; do_next?: string | null; missing_voice?: string | null;
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
  const seenInsightIds = new Map<string, Set<string>>();    // projectId → wisdom ids already posted to Buzz
  const recentEventIds = new Map<string, string[]>();       // channel → recent nostr event ids (for #e citations)
  const pollTimers = new Map<string, NodeJS.Timeout[]>();   // projectId → pending poll timers
  const watched = new Set<string>();

  let ws: WebSocket | null = null;
  let authPending: string | null = null;
  let stopped = false;
  let backoff = 1000;
  const startedAt = Math.floor(Date.now() / 1000);

  // ── Cursor: so a restart never loses messages posted while we were down ─────
  // Shape: { channels: { <uuid>: <last created_at> }, processed: [<event id>, …] }
  const cursorPath = cfg.cursorFile ?? DEFAULT_CURSOR_FILE;
  const store = cfg.cursorStore ?? {
    load: () => { try { return readFileSync(cursorPath, "utf8"); } catch { return null; } },
    save: (state: string) => writeFileSync(cursorPath, state),
  };
  let cursors: Record<string, number> = {};
  let processedIds: string[] = [];
  try {
    const saved = JSON.parse(store.load() ?? "");
    cursors = saved.channels ?? {};
    processedIds = saved.processed ?? [];
    const n = Object.keys(cursors).length;
    if (n) log(`resuming from cursor: ${n} channel(s) tracked`);
  } catch { /* first run — no cursor yet */ }
  const processedSet = new Set(processedIds);

  function saveCursor() {
    try {
      store.save(JSON.stringify({ channels: cursors, processed: processedIds }));
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
  const communityLabel = (() => {
    const host = (() => { try { return new URL(cfg.relayUrl.replace(/^ws/, "http")).host; } catch { return cfg.relayUrl; } })();
    return host.replace(/\.communities\.buzz\.xyz$/i, "");
  })();

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
  }

  // Names make wisdom readable: without this, findings are attributed to raw
  // pubkey prefixes ("411dfdb2's checkout metrics") instead of people.
  function subscribeProfiles() {
    send(["REQ", "profiles", { kinds: [0] }]);
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
    return profileNames.get(pubkey) ?? pubkey.slice(0, 8);
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
      // do_next carries the transfer — the completed work this reader can build on.
      // It was being generated and then dropped, which meant the most useful part of
      // each finding never reached the channel.
      content: [
        wisdom.title,
        "",
        wisdom.body,
        ...(wisdom.do_next ? ["", `→ ${wisdom.do_next}`] : []),
      ].join("\n"),
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
    log(`posted ${wisdom.kind} → ${channel.slice(0, 8)}… citing ${sources.length} source(s)`);
  }

  // ── Step 3 (delayed): poll the real API for wisdom that resulted from recent ingests ──
  function schedulePoll(projectId: string, triggerEventId: string, channel: string) {
    // Restart the sequence on each new message — wisdom is deduped by id, so
    // overlapping polls are harmless, and several attempts mean slow engine runs
    // still get delivered rather than silently dropped.
    for (const t of pollTimers.get(projectId) ?? []) clearTimeout(t);

    const pollOnce = async () => {
      try {
        const res = await gwFetch(`/projects/${projectId}/insights?format=full&limit=20`);
        const seen = seenInsightIds.get(projectId) ?? new Set<string>();
        const fresh: Wisdom[] = (res.data ?? []).filter((w: Wisdom) => !seen.has(w.id));
        if (fresh.length) log(`API returned ${fresh.length} new wisdom for ${projectId.slice(0, 8)}…`);
        for (const w of fresh) { seen.add(w.id); postWisdom(channel, w, triggerEventId); }
        seenInsightIds.set(projectId, seen);
      } catch (e) {
        log(`poll error: ${(e as Error).message}`);
      }
    };

    pollTimers.set(projectId, POLL_SCHEDULE_MS.map(ms => setTimeout(pollOnce, ms)));
  }

  // ── Steps 1 & 2: map an incoming Buzz message to a real GroupWisdom ingest call ──
  async function handleMessage(ev: Event) {
    // Only two messages are ever skipped: our own wisdom (marker tag, not pubkey — the
    // agent may share an identity with a human), and anything already processed.
    // EVERY other kind:9 is ingested, whether it came from a person or another agent.
    if (ev.tags.some(t => t[0] === "gw")) return;
    if (processedSet.has(ev.id)) return;                  // already ingested (restart replay)
    const channel = ev.tags.find(t => t[0] === "h")?.[1];
    if (!channel) return;
    if (!isAllowed(channel)) return;                      // outside the allowlist
    if (ev.created_at < floorFor(channel)) return;        // predates our first sight of this channel
    const content = ev.content ?? "";

    if (cfg.dryRun) {
      log(`[dry-run] would ingest into ${channel.slice(0, 8)}… from ${ev.pubkey.slice(0, 8)}…: "${content.slice(0, 50)}"`);
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
          title: content.slice(0, 60) || "(message)",
          content,
          type: "note",
          contributed_by: contributorName(ev.pubkey),
        }),
      });
      markProcessed(channel, ev);   // only after the API accepted it, so a failure retries on restart
      log(`ingested → GroupWisdom | ${channelNames.get(channel) ?? channel.slice(0, 8)} | from ${contributorName(ev.pubkey)}: "${content.slice(0, 50)}"`);
      schedulePoll(projectId, ev.id, channel);
    } catch (e) {
      log(`ingest failed for ${channel.slice(0, 8)}…: ${(e as Error).message}`);
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
        else if (ev.kind === 44100) {
          const channel = ev.tags.find(t => t[0] === "h")?.[1];
          if (channel) subscribeChannel(channel);
        } else if (ev.kind === 0) {
          try {
            const meta = JSON.parse(ev.content || "{}");
            const name = meta.display_name || meta.name;
            if (name) profileNames.set(ev.pubkey, String(name).slice(0, 40));
          } catch { /* malformed profile — keep the pubkey fallback */ }
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
