/**
 * Talking to the Bot Framework: proving who we are on the way out, and proving
 * who Microsoft is on the way in.
 *
 * Written against the HTTP surface directly rather than the Bot Framework SDK.
 * That SDK brings a large dependency tree for what amounts to two token calls
 * and a POST, and the rest of this project has stayed dependency-light on
 * purpose. Nothing here needs anything that is not already installed.
 *
 * The inbound half matters more than it looks. Our messaging endpoint is a
 * public URL that accepts JSON describing what people said, and without
 * verification anyone who learns the address could post fabricated messages
 * into a customer's project: invented findings attributed to real colleagues,
 * billed to the customer's allowance. Every inbound request is therefore
 * checked against Microsoft's published signing keys before it is read.
 */
import { createPublicKey, createVerify, timingSafeEqual } from "node:crypto";

// ── Outbound: proving we are the app we claim to be ─────────────────────────

/**
 * Where a bot asks for its own token depends on how its identity is registered,
 * and the registration Microsoft still offers changed under us.
 *
 * Multi-tenant bot creation was retired after 31 July 2025, so a bot registered
 * today is single-tenant: it authenticates against its own home tenant rather
 * than the shared `botframework.com` endpoint. Cross-tenant reach comes from the
 * Entra app registration being multi-tenant and the Teams app being distributed
 * through AppSource, which is a distribution question rather than a token one.
 *
 * Both endpoints are kept because existing multi-tenant bots keep working
 * indefinitely, and because a tenant id in configuration is a cheaper way to be
 * wrong about this than a redeploy.
 */
const LOGIN_URL_MULTITENANT = "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";
const BOT_SCOPE = "https://api.botframework.com/.default";

export function loginUrlFor(tenantId?: string): string {
  const t = String(tenantId ?? "").trim();
  return t
    ? `https://login.microsoftonline.com/${encodeURIComponent(t)}/oauth2/v2.0/token`
    : LOGIN_URL_MULTITENANT;
}

type Cached = { token: string; expiresAt: number };
/** Keyed by identity, so a credential or tenant change cannot be served a stale token. */
const botTokenCache = new Map<string, Cached>();

/**
 * An app token for the Bot Framework, cached until shortly before it expires.
 *
 * Microsoft issues these for about an hour. The refresh happens a minute early
 * rather than on expiry, because a token that dies mid-flight surfaces as a 401
 * on a card the customer never sees, which is the least debuggable failure this
 * adapter could have.
 */
export async function getBotToken(opts: {
  appId?: string;
  appPassword?: string;
  tenantId?: string;
  now?: number;
} = {}): Promise<string> {
  const appId = opts.appId ?? process.env.TEAMS_APP_ID ?? "";
  const appPassword = opts.appPassword ?? process.env.TEAMS_APP_PASSWORD ?? "";
  const tenantId = opts.tenantId ?? process.env.TEAMS_APP_TENANT_ID ?? "";
  const now = opts.now ?? Date.now();

  if (!appId || !appPassword) throw new Error("TEAMS_APP_ID and TEAMS_APP_PASSWORD are not set");

  const cacheKey = `${appId}::${tenantId}`;
  const hit = botTokenCache.get(cacheKey);
  if (hit && hit.expiresAt > now) return hit.token;

  const res = await fetch(loginUrlFor(tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: appId,
      client_secret: appPassword,
      scope: BOT_SCOPE,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Bot Framework token ${res.status}: ${text.slice(0, 200)}`);

  let body: any;
  try { body = JSON.parse(text); } catch { throw new Error("Bot Framework token response was not JSON"); }
  if (!body?.access_token) throw new Error("Bot Framework token response carried no access_token");

  botTokenCache.set(cacheKey, {
    token: body.access_token,
    expiresAt: now + Math.max(0, (Number(body.expires_in) || 3600) - 60) * 1000,
  });
  return body.access_token;
}

/** Only for tests, and for forcing a refresh after a credential change. */
export const clearBotTokenCache = () => { botTokenCache.clear(); };

/**
 * Post an activity into a conversation.
 *
 * The service URL comes from the inbound activity rather than configuration,
 * because Microsoft routes tenants to regional hosts and documents it as a
 * per-conversation value. Hardcoding one works until the first customer outside
 * that region, which is the worst time to find out.
 */
export async function postActivity(
  ref: { serviceUrl: string; conversationId: string },
  activity: unknown,
  token?: string,
): Promise<{ id?: string }> {
  const bearer = token ?? await getBotToken();
  const url = `${ref.serviceUrl.replace(/\/+$/, "")}/v3/conversations/${encodeURIComponent(ref.conversationId)}/activities`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify(activity),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Teams post ${res.status}: ${text.slice(0, 200)}`);
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

// ── Inbound: proving Microsoft sent it ──────────────────────────────────────

const OPENID_CONFIG = "https://login.botframework.com/v1/.well-known/openidconfiguration";
const ISSUER = "https://api.botframework.com";

type Jwk = { kid?: string; kty?: string; use?: string; n?: string; e?: string; [k: string]: unknown };
let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Microsoft's current signing keys.
 *
 * Cached for a day, and refetched on a miss: keys rotate, and a signature from
 * a key minted after our last fetch is valid but unrecognised. Treating an
 * unknown kid as a cache miss rather than a rejection is what keeps rotation
 * from looking like an attack.
 */
async function getSigningKeys(force = false): Promise<Jwk[]> {
  const now = Date.now();
  if (!force && jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;

  const conf = await fetch(OPENID_CONFIG).then(r => r.json() as Promise<{ jwks_uri?: string }>);
  if (!conf?.jwks_uri) throw new Error("Bot Framework openid configuration carried no jwks_uri");
  const jwks = await fetch(conf.jwks_uri).then(r => r.json() as Promise<{ keys?: Jwk[] }>);
  if (!Array.isArray(jwks?.keys)) throw new Error("Bot Framework jwks carried no keys");

  jwksCache = { keys: jwks.keys, fetchedAt: now };
  return jwks.keys;
}

export const clearJwksCache = () => { jwksCache = null; };

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Constant-time string compare, so a claim check cannot be probed by timing. */
function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type VerifyResult = { ok: true; claims: Record<string, unknown> } | { ok: false; reason: string };

/**
 * Verify the bearer token on an inbound activity.
 *
 * Checks, in order: the token parses, it is RS256 rather than `none`, it was
 * signed by a key Microsoft publishes, it was issued by the Bot Framework, it
 * names our app as the audience, and it has not expired. A failure at any point
 * returns a reason rather than throwing, so the caller can answer 401 and log
 * which check failed without leaking that to the caller.
 */
export async function verifyInboundJwt(
  authorizationHeader: string | undefined,
  appId = process.env.TEAMS_APP_ID ?? "",
  now = Date.now(),
): Promise<VerifyResult> {
  const raw = String(authorizationHeader ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!raw) return { ok: false, reason: "no bearer token" };
  if (!appId) return { ok: false, reason: "TEAMS_APP_ID is not set, so no audience to check against" };

  const parts = raw.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };

  let header: any, claims: any;
  try {
    header = JSON.parse(b64url(parts[0]).toString("utf8"));
    claims = JSON.parse(b64url(parts[1]).toString("utf8"));
  } catch { return { ok: false, reason: "token header or claims were not JSON" }; }

  // "alg": "none" is the classic forgery, and an unexpected algorithm is never
  // something to accommodate.
  if (header?.alg !== "RS256") return { ok: false, reason: `unexpected alg ${header?.alg}` };
  if (!header?.kid) return { ok: false, reason: "token names no signing key" };

  let keys = await getSigningKeys();
  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) {
    keys = await getSigningKeys(true);          // a rotation, not an attack
    jwk = keys.find(k => k.kid === header.kid);
  }
  if (!jwk) return { ok: false, reason: "signing key is not one Microsoft publishes" };

  let verified = false;
  try {
    const key = createPublicKey({ key: jwk as any, format: "jwk" });
    verified = createVerify("RSA-SHA256")
      .update(`${parts[0]}.${parts[1]}`)
      .verify(key, b64url(parts[2]));
  } catch { return { ok: false, reason: "signature could not be checked" }; }
  if (!verified) return { ok: false, reason: "signature did not verify" };

  if (!sameString(String(claims?.iss ?? ""), ISSUER)) return { ok: false, reason: "wrong issuer" };
  if (!sameString(String(claims?.aud ?? ""), appId)) return { ok: false, reason: "token was issued for a different app" };

  const exp = Number(claims?.exp) * 1000;
  if (!Number.isFinite(exp) || exp <= now) return { ok: false, reason: "token has expired" };
  const nbf = Number(claims?.nbf) * 1000;
  if (Number.isFinite(nbf) && nbf > now + 5 * 60_000) return { ok: false, reason: "token is not valid yet" };

  return { ok: true, claims };
}

/**
 * The service URL an activity claims must belong to Microsoft.
 *
 * The URL is taken from the request body and then used as the destination for
 * an authenticated POST, so an unchecked value would let a forged activity aim
 * our bot token at a host of someone else's choosing. Verified tokens make that
 * hard already; this makes it impossible.
 */
export function isTrustedServiceUrl(serviceUrl: string): boolean {
  let host: string;
  try { const u = new URL(String(serviceUrl)); if (u.protocol !== "https:") return false; host = u.hostname.toLowerCase(); }
  catch { return false; }
  return host === "botframework.com"
    || host.endsWith(".botframework.com")
    || host.endsWith(".trafficmanager.net");
}
