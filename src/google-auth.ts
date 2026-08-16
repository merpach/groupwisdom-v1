/**
 * Sign in with Google (OAuth 2.0 authorization code flow).
 *
 * No new dependency: the flow is three HTTPS calls, and doing it directly keeps
 * the moving parts visible. The code never touches the browser's JavaScript —
 * the secret stays server-side and the token exchange is server-to-server.
 *
 *   GET /auth/google           → redirect to Google's consent screen
 *   GET /auth/google/callback  → exchange the code, sign the person in
 *
 * Identity comes from Google's userinfo endpoint over a fresh server-to-server
 * HTTPS call, so there is no token to forge and no JWT signature to verify by
 * hand. Only verified emails are accepted: an unverified one would let anyone
 * who can create a Google account with someone else's address take over the
 * matching GroupWisdom account.
 *
 * Enabled by setting GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Unset, every
 * route here 404s and the button never renders, so nothing changes.
 */
import { Router } from "express";
import { randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import { getUserByEmail, createUser } from "./db.js";

export const googleAuth = Router();

const CLIENT_ID = () => process.env.GOOGLE_CLIENT_ID?.trim() || "";
const CLIENT_SECRET = () => process.env.GOOGLE_CLIENT_SECRET?.trim() || "";
export const googleAuthEnabled = () => Boolean(CLIENT_ID() && CLIENT_SECRET());

/**
 * Where Google sends people back. Derived from the request so the same build
 * works on every domain this is served from, with GOOGLE_REDIRECT_URI as an
 * override. Deriving from the Host header is safe here because Google refuses
 * any redirect_uri that is not registered in the console, so a forged host
 * cannot redirect a code anywhere new.
 */
function redirectUri(req: any): string {
  const override = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (override) return override;
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string)?.split(",")[0] || req.get("host");
  return `${proto}://${host}/auth/google/callback`;
}

/**
 * Only same-origin paths, so ?next= cannot be used as an open redirect.
 * Non-strings are refused outright: a repeated query parameter arrives as an
 * array, and String(["/a","/b"]) is "/a,/b", which would otherwise slip past
 * the pattern since a comma is legal in a path.
 */
export function safeNext(next: unknown): string {
  if (typeof next !== "string") return "/buzz";
  return /^\/[A-Za-z0-9\-._~/?#[\]@!$&'()*+,;=]*$/.test(next) && !next.startsWith("//") ? next : "/buzz";
}

googleAuth.get("/auth/google", (req: any, res) => {
  if (!googleAuthEnabled()) return res.status(404).send("Google sign-in is not configured on this server.");

  // The state ties the callback to this browser session: without it, an
  // attacker could feed someone their own authorization code and land that
  // person in the attacker's account.
  const state = randomBytes(16).toString("hex");
  req.session.googleState = state;
  req.session.googleNext = safeNext(req.query.next);

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", CLIENT_ID());
  url.searchParams.set("redirect_uri", redirectUri(req));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  res.redirect(url.toString());
});

googleAuth.get("/auth/google/callback", async (req: any, res) => {
  if (!googleAuthEnabled()) return res.status(404).send("Google sign-in is not configured on this server.");

  const fail = (why: string) => {
    console.warn(`[google-auth] ${why}`);       // reason to the log, not to the browser
    res.redirect("/buzz?auth_error=1");
  };

  const { code, state, error } = req.query as Record<string, string | undefined>;
  if (error) return fail(`consent declined: ${error}`);
  if (!code) return fail("callback without a code");

  const expected = req.session.googleState;
  const next = safeNext(req.session.googleNext);
  delete req.session.googleState;              // single use, whatever happens next
  delete req.session.googleNext;
  if (!expected || state !== expected) return fail("state mismatch");

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID(),
        client_secret: CLIENT_SECRET(),
        redirect_uri: redirectUri(req),
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) return fail(`token exchange failed: ${tokenRes.status}`);
    const { access_token } = await tokenRes.json() as { access_token?: string };
    if (!access_token) return fail("token exchange returned no access token");

    const infoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!infoRes.ok) return fail(`userinfo failed: ${infoRes.status}`);
    const info = await infoRes.json() as { email?: string; email_verified?: boolean; name?: string };

    const email = info.email?.toLowerCase().trim();
    if (!email) return fail("userinfo returned no email");
    if (info.email_verified === false) return fail("email is not verified with Google");

    let user = getUserByEmail(email);
    if (!user) {
      // Google accounts have no password here. Hashing a long random string
      // means no password can ever match, rather than leaving a hash that
      // bcrypt might treat as malformed.
      const unusable = await bcrypt.hash(randomBytes(32).toString("hex"), 10);
      user = createUser(email, unusable, (info.name || email.split("@")[0]).slice(0, 60));
      console.log(`[google-auth] created account for ${email}`);
    }

    // Rotate the session id on sign-in so a pre-existing cookie cannot be
    // reused to ride someone else's new session.
    req.session.regenerate((err: any) => {
      if (err) return fail(`session regenerate failed: ${err.message}`);
      req.session.userId = user!.id;
      res.redirect(next);
    });
  } catch (err: any) {
    fail(`unexpected: ${err.message}`);
  }
});
