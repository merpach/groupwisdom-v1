/**
 * Supabase as the identity provider.
 *
 * What it buys over rolling our own: password reset, email confirmation, and
 * every social provider from one dashboard toggle instead of a new OAuth
 * implementation each time.
 *
 * The browser never sees a Supabase token. Every call to Supabase happens
 * server-to-server and the result becomes our own httpOnly session cookie, the
 * same one the rest of the app already understands. That keeps tokens out of
 * localStorage (where any XSS would reach them), needs no change to the CSP
 * since the browser still only talks to our origin, and means /api/me,
 * /buzz/connections and the rest keep working untouched.
 *
 * Local password accounts keep working. Supabase is added alongside, not on
 * top: existing users signed up before this and their bcrypt hashes live in
 * our database, so login tries local first and falls back to Supabase.
 *
 * Enabled by SUPABASE_URL + SUPABASE_ANON_KEY. The anon key is enough for
 * signup, login, recovery and identity lookup; the service-role key is
 * deliberately not used, since it bypasses row-level security and nothing here
 * needs that reach.
 */
import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import { getUserByEmail, createUser, type User } from "./db.js";
import { safeNext, requestOrigin } from "./http-util.js";

export const supabaseAuth = Router();

/**
 * The project's base URL, e.g. https://abc123.supabase.co.
 *
 * The dashboard shows a Data API URL ending in /rest/v1, and pasting that is
 * the obvious mistake to make: every auth call then goes to
 * /rest/v1/auth/v1/... and 404s with nothing explaining why. Any API path
 * suffix is trimmed here rather than left to fail at request time.
 */
const URL_ = () => {
  const raw = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "") || "";
  return raw.replace(/\/(rest|auth|storage|realtime|functions)\/v\d+$/i, "");
};

/**
 * The browser-safe key. Supabase renamed these: new projects issue a
 * "publishable" key (sb_publishable_…) where older ones had "anon". They are
 * used identically in the apikey header, so either name is accepted rather
 * than forcing a dashboard-to-code mismatch.
 *
 * Never the secret key (sb_secret_… or service_role). That one bypasses row
 * level security, and nothing in this flow needs that reach.
 */
const ANON = () => (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY)?.trim() || "";
export const supabaseAuthEnabled = () => Boolean(URL_() && ANON());

// Loud, early, and only once: a secret key here would be a real mistake, and
// silently working is worse than not starting.
if (/^sb_secret_|service_role/.test(ANON())) {
  console.error("[supabase-auth] SUPABASE_PUBLISHABLE_KEY looks like a SECRET key. Use the publishable (browser-safe) key instead.");
}

/** Social providers offered on the sign-in page. Each must also be enabled in the Supabase dashboard. */
const PROVIDERS = (process.env.SUPABASE_PROVIDERS?.trim() || "google")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
export const supabaseProviders = () => (supabaseAuthEnabled() ? PROVIDERS : []);

/**
 * Never throws. An unreachable Supabase — outage, DNS, a wrong URL — must come
 * back as a failed result, not an exception: these run inside async Express
 * handlers, which do not catch rejections, so a throw here would take the
 * process down and with it the whole site, including local password sign-in
 * that has nothing to do with Supabase.
 */
async function sb(path: string, init: RequestInit = {}) {
  try {
    const res = await fetch(URL_() + path, {
      ...init,
      headers: { apikey: ANON(), "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(10_000),   // a hung provider must not hang sign-in
    });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { ok: res.ok, status: res.status, body };
  } catch (err: any) {
    console.warn(`[supabase-auth] request to ${path.split("?")[0]} failed: ${err.message}`);
    return { ok: false, status: 0, body: { msg: "Sign-in is temporarily unavailable. Please try again." } };
  }
}

/**
 * Find or create the local row for a Supabase identity. We still need our own
 * user: the API key, projects, memory and spend cap all hang off it.
 */
async function localUserFor(email: string, name?: string): Promise<User> {
  const clean = email.toLowerCase().trim();
  const existing = getUserByEmail(clean);
  if (existing) return existing;
  // Supabase holds the password. A bcrypt hash of a long random string means
  // no local password can ever match, rather than leaving something malformed.
  const unusable = await bcrypt.hash(randomBytes(32).toString("hex"), 10);
  const user = createUser(clean, unusable, (name || clean.split("@")[0]).slice(0, 60));
  console.log(`[supabase-auth] created local account for ${clean}`);
  return user;
}

export type SupabaseResult =
  | { ok: true; user: User }
  | { ok: false; error: string; needsConfirmation?: boolean };

/** Email + password sign-up through Supabase, so recovery emails work later. */
export async function supabaseSignUp(email: string, password: string, name: string): Promise<SupabaseResult> {
  const r = await sb("/auth/v1/signup", { method: "POST", body: JSON.stringify({ email, password, data: { name } }) });
  if (!r.ok) return { ok: false, error: r.body?.msg || r.body?.error_description || "Could not create that account." };

  // With email confirmation switched on, Supabase returns the user but no
  // session. That is not a failure, it just means they have to click the link.
  if (!r.body?.access_token) return { ok: false, error: "Check your email to confirm your account, then sign in.", needsConfirmation: true };
  return { ok: true, user: await localUserFor(email, name) };
}

export async function supabaseSignIn(email: string, password: string): Promise<SupabaseResult> {
  const r = await sb("/auth/v1/token?grant_type=password", { method: "POST", body: JSON.stringify({ email, password }) });
  if (!r.ok || !r.body?.access_token) {
    return { ok: false, error: r.body?.msg || r.body?.error_description || "Incorrect email or password." };
  }
  const u = r.body.user ?? {};
  return { ok: true, user: await localUserFor(u.email || email, u.user_metadata?.name) };
}

/** Ask Supabase to email a reset link. Always reported as sent, so this cannot be used to discover which emails have accounts. */
export async function supabaseSendReset(email: string, redirectTo: string): Promise<void> {
  await sb(`/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`, {
    method: "POST", body: JSON.stringify({ email }),
  }).catch(() => { /* best effort, never reveal the outcome */ });
}

// ── Social sign-in (PKCE, entirely server side) ──────────────────────────────

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

supabaseAuth.get("/auth/supabase/:provider", (req: any, res) => {
  if (!supabaseAuthEnabled()) return res.status(404).send("Supabase sign-in is not configured on this server.");
  const provider = String(req.params.provider).toLowerCase();
  if (!PROVIDERS.includes(provider)) return res.status(404).send("That sign-in provider is not enabled.");

  // PKCE: the verifier stays in our session and never reaches the browser, so
  // an intercepted authorization code is useless on its own.
  const verifier = b64url(randomBytes(32));
  req.session.sbVerifier = verifier;
  req.session.sbNext = safeNext(req.query.next);

  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const url = new URL(URL_() + "/auth/v1/authorize");
  url.searchParams.set("provider", provider);
  url.searchParams.set("redirect_to", `${requestOrigin(req)}/auth/supabase/callback`);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "s256");
  res.redirect(url.toString());
});

supabaseAuth.get("/auth/supabase/callback", async (req: any, res) => {
  if (!supabaseAuthEnabled()) return res.status(404).send("Supabase sign-in is not configured on this server.");

  const fail = (why: string) => {
    console.warn(`[supabase-auth] ${why}`);        // reason to the log, never to the browser
    res.redirect("/buzz?auth_error=1");
  };

  const { code, error, error_description } = req.query as Record<string, string | undefined>;
  const verifier = req.session.sbVerifier;
  const next = safeNext(req.session.sbNext);
  delete req.session.sbVerifier;                    // single use, whatever happens
  delete req.session.sbNext;

  if (error) return fail(`provider returned ${error}: ${error_description ?? ""}`);
  if (!code) return fail("callback without a code");
  if (!verifier) return fail("no PKCE verifier in session");

  try {
    const r = await sb("/auth/v1/token?grant_type=pkce", {
      method: "POST", body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
    });
    if (!r.ok || !r.body?.access_token) return fail(`code exchange failed: ${r.status}`);

    const u = r.body.user ?? {};
    const email = String(u.email ?? "").toLowerCase().trim();
    if (!email) return fail("no email on the returned identity");

    const user = await localUserFor(email, u.user_metadata?.name || u.user_metadata?.full_name);

    // Rotate the session id so a pre-existing cookie cannot ride the new session.
    req.session.regenerate((err: any) => {
      if (err) return fail(`session regenerate failed: ${err.message}`);
      req.session.userId = user.id;
      res.redirect(next);
    });
  } catch (err: any) {
    fail(`unexpected: ${err.message}`);
  }
});
