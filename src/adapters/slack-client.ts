/**
 * The handful of Slack Web API calls the integration makes, and nothing else.
 *
 * Every call is form-encoded with the token in the Authorization header. Slack
 * accepts that for every method, where JSON bodies are refused by some of the
 * read methods; nested values such as `blocks` travel as JSON strings, which
 * Slack documents for form-encoded requests.
 *
 * SLACK_API_BASE exists for tests, which point it at a local fake. Nothing in
 * this file logs a token or a message.
 */

const apiBase = () => (process.env.SLACK_API_BASE || "https://slack.com/api").replace(/\/$/, "");

export class SlackApiError extends Error {
  constructor(public method: string, public code: string) {
    super(`${method}: ${code}`);
  }
}

function form(params: Record<string, unknown>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    out.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return out.toString();
}

/**
 * One Web API call. A 429 is retried once when Slack asks for a short wait;
 * anything longer is reported rather than slept through in a request handler.
 */
export async function slackCall(method: string, token: string | null, params: Record<string, unknown> = {}): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${apiBase()}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: form(params),
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") ?? "1");
      if (attempt === 0 && wait <= 5) { await new Promise(r => setTimeout(r, wait * 1000)); continue; }
      throw new SlackApiError(method, "ratelimited");
    }
    const data = await res.json().catch(() => ({ ok: false, error: `http_${res.status}` })) as any;
    if (!data?.ok) throw new SlackApiError(method, String(data?.error ?? `http_${res.status}`));
    return data;
  }
  throw new SlackApiError(method, "ratelimited");
}

/** Exchange the code from the OAuth redirect for the workspace's bot token. */
export function oauthAccess(code: string, redirectUri: string) {
  return slackCall("oauth.v2.access", null, {
    client_id: process.env.SLACK_CLIENT_ID,
    client_secret: process.env.SLACK_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
  });
}

/** Revoke our install from a workspace, for a disconnect started on our site. */
export function appsUninstall(token: string) {
  return slackCall("apps.uninstall", token, {
    client_id: process.env.SLACK_CLIENT_ID,
    client_secret: process.env.SLACK_CLIENT_SECRET,
  });
}

export async function postMessage(token: string, params: {
  channel: string; text: string; blocks?: unknown[]; thread_ts?: string; reply_broadcast?: boolean;
}): Promise<{ ts: string | null }> {
  const data = await slackCall("chat.postMessage", token, {
    ...params,
    unfurl_links: false,
    unfurl_media: false,
  });
  return { ts: data?.ts ?? null };
}

export async function channelInfo(token: string, channel: string): Promise<{ name: string; shared: boolean; isPrivate: boolean }> {
  const data = await slackCall("conversations.info", token, { channel });
  const c = data?.channel ?? {};
  return {
    name: String(c.name ?? ""),
    // Shared with another workspace in any form: Slack Connect or an org-shared channel.
    shared: Boolean(c.is_ext_shared || c.is_shared || c.is_pending_ext_shared),
    isPrivate: Boolean(c.is_private),
  };
}

// ── Names ────────────────────────────────────────────────────────────────────
// Findings attribute work by name, and a message carries only a user id. One
// users.info per person per few hours, kept in memory: a deploy re-learns them.

const NAME_TTL_MS = 6 * 60 * 60 * 1000;
const names = new Map<string, { name: string; at: number }>();

export async function userName(token: string, teamId: string, userId: string): Promise<string> {
  const key = `${teamId}:${userId}`;
  const hit = names.get(key);
  if (hit && Date.now() - hit.at < NAME_TTL_MS) return hit.name;
  try {
    const data = await slackCall("users.info", token, { user: userId });
    const u = data?.user ?? {};
    const name = String(u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || "").trim() || "Someone";
    names.set(key, { name, at: Date.now() });
    return name;
  } catch {
    return "Someone";
  }
}

/** For tests: forget every cached name. */
export const forgetSlackNames = () => names.clear();

/** Answer a slash command or button press later, through the URL Slack gave us. */
export async function respondTo(responseUrl: string, body: Record<string, unknown>): Promise<void> {
  if (!/^https:\/\/hooks\.slack\.com\//.test(responseUrl) && !process.env.SLACK_API_BASE) return;
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
