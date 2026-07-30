/**
 * Buzz supervisor — keeps every connected Buzz community running, hosted.
 *
 * This is what makes the integration hosted rather than something you run in a
 * terminal. On server boot it reads every enabled row from `buzz_connections`
 * and opens one relay connection per community, so a community stays connected
 * across restarts and deploys with nothing on anyone's machine.
 *
 *   GroupWisdom (Railway)
 *     ├── Express API
 *     └── supervisor ──▶ one adapter per connected community
 *                          │
 *                message ──┴──▶ that channel's GroupWisdom project
 *                                        │  two-pass engine
 *                wisdom ◀─────────────────┘  back into the Buzz chat
 *
 * Why a held connection rather than webhooks: Buzz's hosted relay stores
 * workflow definitions but does not execute them (verified — no workflow run
 * events, kinds 46001-46012, have ever been emitted), so Buzz cannot push
 * messages to us. src/buzz-hook.ts implements the webhook path for
 * self-hosted relays, where workflows do run.
 *
 * One agent identity (BUZZ_AGENT_NSEC) serves every community: each connection
 * carries a NIP-OA attestation from one of that community's members, and the
 * relay grants access derived from that member's own membership (NIP-AA).
 */
import { startBuzzAdapter } from "./adapters/buzz.js";
import { parseAuthTag } from "./adapters/nip-oa.js";
import {
  listEnabledBuzzConnections,
  getBuzzConnection,
  getUserById,
  markBuzzConnected,
  markBuzzConnectionError,
  getBuzzCursor,
  setBuzzCursor,
  setBuzzConnectionDiscovered,
  type BuzzConnection,
} from "./db.js";

type Handle = { stop: () => void };

const running = new Map<string, Handle>();   // connection id → adapter handle

/**
 * Live authentication state per connection. The adapter connects asynchronously,
 * so "we started it" is not the same as "it works" — without this, connecting to
 * a community that does not exist, or that the agent cannot join, reported
 * success and left the user waiting for wisdom that could never arrive.
 */
type Status = { authed: boolean; error?: string };
const status = new Map<string, Status>();

/** Resolve once the connection has authenticated or demonstrably failed. */
export function waitForConnectionResult(id: string, timeoutMs = 9000): Promise<Status> {
  const started = Date.now();
  return new Promise(resolve => {
    const tick = () => {
      const s = status.get(id);
      if (s?.authed) return resolve(s);
      if (s?.error) return resolve(s);
      if (Date.now() - started > timeoutMs) {
        return resolve({ authed: false, error: "timed out waiting for the community to respond" });
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

export function connectionStatus(id: string): Status | undefined {
  return status.get(id);
}

function parseChannels(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length ? arr.map(String) : undefined;
  } catch { return undefined; }
}

function agentKey(): string | null {
  return process.env.BUZZ_AGENT_NSEC || process.env.BUZZ_PRIVATE_KEY || null;
}

/** The API base the adapter should use. In-server, that's this very process. */
function selfApiBase(): string {
  if (process.env.GROUPWISDOM_BASE_URL) return process.env.GROUPWISDOM_BASE_URL;
  const port = process.env.PORT || "3000";
  return `http://127.0.0.1:${port}/v1`;
}

/** Open (or reopen) the connection for one community. */
export function startConnection(conn: BuzzConnection): { ok: boolean; error?: string } {
  stopConnection(conn.id);
  status.set(conn.id, { authed: false });

  const nsec = agentKey();
  if (!nsec) {
    const error = "BUZZ_AGENT_NSEC is not set on the server";
    markBuzzConnectionError(conn.id, error);
    return { ok: false, error };
  }

  const owner = getUserById(conn.user_id);
  if (!owner) {
    const error = "connection owner no longer exists";
    markBuzzConnectionError(conn.id, error);
    return { ok: false, error };
  }

  let authTag;
  if (conn.auth_tag) {
    try {
      authTag = parseAuthTag(conn.auth_tag);
    } catch (e) {
      const error = `invalid attestation: ${(e as Error).message}`;
      markBuzzConnectionError(conn.id, error);
      return { ok: false, error };
    }
  }

  try {
    const handle = startBuzzAdapter({
      relayUrl: conn.relay_url,
      privateKey: nsec,
      // Projects land on the connecting user's own GroupWisdom account, so
      // attribution and budget accounting stay per-customer.
      groupwisdomApiKey: owner.api_key,
      groupwisdomBaseUrl: selfApiBase(),
      authTag,
      // Restrict to chosen channels when set, so a busy workspace can't be
      // ingested (and billed) in full just because the agent can see it.
      channels: parseChannels(conn.channels),
      onChannelsDiscovered: (chans) => {
        try { setBuzzConnectionDiscovered(conn.id, chans); } catch { /* best effort */ }
      },
      // Durable cursor: the container filesystem does not survive a deploy, and a
      // lost cursor means re-ingesting (and re-billing) messages already handled.
      cursorStore: {
        load: () => getBuzzCursor(conn.id),
        save: (state) => setBuzzCursor(conn.id, state),
      },
      onLog: (msg) => {
        console.log(`[buzz:${conn.id.slice(0, 8)}] ${msg}`);
        if (msg.startsWith("authenticated")) {
          status.set(conn.id, { authed: true });
          markBuzzConnected(conn.id);
        } else if (msg.startsWith("auth rejected")) {
          status.set(conn.id, { authed: false, error: msg.replace(/^auth rejected:\s*/, "") });
          markBuzzConnectionError(conn.id, msg);
        } else if (msg.startsWith("ws error") || msg.startsWith("reconnecting")) {
          // Only record as an error while we have never authenticated; an
          // established connection dropping is normal and self-heals.
          if (!status.get(conn.id)?.authed) {
            status.set(conn.id, { authed: false, error: "could not reach that community" });
          }
        }
      },
    });
    running.set(conn.id, handle);
    return { ok: true };
  } catch (e) {
    const error = (e as Error).message;
    markBuzzConnectionError(conn.id, error);
    return { ok: false, error };
  }
}

export function stopConnection(id: string) {
  const handle = running.get(id);
  if (handle) {
    handle.stop();
    running.delete(id);
  }
  status.delete(id);
}

/** Running *and* authenticated — what a user means by "connected". */
export function isConnectionRunning(id: string): boolean {
  return running.has(id) && Boolean(status.get(id)?.authed);
}

export function restartConnection(id: string) {
  const conn = getBuzzConnection(id);
  if (conn && conn.enabled) startConnection(conn);
  else stopConnection(id);
}

/** Called once on server boot. Safe to call when nothing is configured. */
export function startBuzzSupervisor() {
  const conns = listEnabledBuzzConnections();
  if (!conns.length) return;

  if (!agentKey()) {
    console.warn(
      `[buzz] ${conns.length} Buzz connection(s) configured but BUZZ_AGENT_NSEC is not set — not connecting.`,
    );
    return;
  }

  console.log(`[buzz] supervisor starting ${conns.length} connection(s)`);
  for (const conn of conns) {
    const res = startConnection(conn);
    if (!res.ok) console.warn(`[buzz] connection ${conn.id.slice(0, 8)} failed: ${res.error}`);
  }
}

export function stopBuzzSupervisor() {
  for (const id of [...running.keys()]) stopConnection(id);
}
