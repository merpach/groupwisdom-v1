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
  type BuzzConnection,
} from "./db.js";

type Handle = { stop: () => void };

const running = new Map<string, Handle>();   // connection id → adapter handle

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
      // Durable cursor: the container filesystem does not survive a deploy, and a
      // lost cursor means re-ingesting (and re-billing) messages already handled.
      cursorStore: {
        load: () => getBuzzCursor(conn.id),
        save: (state) => setBuzzCursor(conn.id, state),
      },
      onLog: (msg) => {
        console.log(`[buzz:${conn.id.slice(0, 8)}] ${msg}`);
        if (msg.startsWith("authenticated")) markBuzzConnected(conn.id);
        if (msg.startsWith("auth rejected")) markBuzzConnectionError(conn.id, msg);
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
}

export function isConnectionRunning(id: string): boolean {
  return running.has(id);
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
