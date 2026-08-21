import express from "express";
import session from "express-session";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import bcrypt from "bcrypt";
import { api, setNotifier } from "./api.js";
import { apiv1, setV1Notifier } from "./api-v1.js";
import { buzzHook } from "./buzz-hook.js";
import { teamsHook } from "./teams-hook.js";
import { startBuzzSupervisor } from "./buzz-supervisor.js";
import { runningRouter, CLUB_GROUP_ID } from "./running.js";
import { handleMcpRequest } from "./mcp-http.js";
import { getUserByEmail, createUser, encryptExistingData, pruneOldBuzzItems, pruneOldGateRecords } from "./db.js";
import { encryptionEnabled } from "./crypto.js";
import { rateLimit, apiKeyOrIp } from "./ratelimit.js";
import { googleAuth } from "./google-auth.js";
import { supabaseAuth } from "./supabase-auth.js";
import { randomBytes } from "node:crypto";

// Ensure demo user exists for the /v1/demo endpoint
const DEMO_EMAIL = "demo@groupwisdom.internal";
if (!getUserByEmail(DEMO_EMAIL)) {
  createUser(DEMO_EMAIL, await bcrypt.hash("no-login-" + Math.random(), 10), "Demo");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);

// Behind Railway's proxy: needed for req.ip (rate limiting) and secure cookies.
app.set("trust proxy", 1);
app.disable("x-powered-by");

// Baseline security headers on every response. CSP is scoped to what the pages
// actually are — self-contained HTML with inline styles and scripts, no third
// parties — so nothing external can be injected even if markup slips through.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// WebSocket server — clients subscribe to a group id
const wss = new WebSocketServer({ server });
const subscribers = new Map<string, Set<any>>(); // groupId → set of sockets

wss.on("connection", (ws) => {
  let groupId: string | null = null;
  ws.on("message", (msg) => {
    try {
      const { subscribe } = JSON.parse(msg.toString());
      if (subscribe) {
        groupId = subscribe;
        if (!subscribers.has(groupId!)) subscribers.set(groupId!, new Set());
        subscribers.get(groupId!)!.add(ws);
      }
    } catch {}
  });
  ws.on("close", () => {
    if (groupId) subscribers.get(groupId)?.delete(ws);
  });
});

// Wire both routers to the same WebSocket notifier
setV1Notifier((groupId: string, event: string) => {
  const sockets = subscribers.get(groupId);
  if (!sockets?.size) return;
  const msg = JSON.stringify({ event, groupId });
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(msg);
  }
});

// Called by the API whenever something changes in a group
setNotifier((groupId: string, event: string) => {
  const sockets = subscribers.get(groupId);
  if (!sockets?.size) return;
  const msg = JSON.stringify({ event, groupId });
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(msg);
  }
});

// A constant fallback secret in production means anyone who has read the source
// can forge a session cookie. A per-boot random secret costs re-login on deploy,
// which is the safe direction; setting SESSION_SECRET removes even that cost.
const inProd = Boolean(process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT);
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (inProd) console.warn("[security] SESSION_SECRET not set — using a random per-boot secret (sessions reset on deploy). Set SESSION_SECRET to keep sessions across deploys.");
  sessionSecret = inProd ? randomBytes(32).toString("hex") : "gw-dev-secret-change-in-prod";
}
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: inProd, maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 days
}));
app.use(express.json({ limit: "2mb" }));
// A JSON API must answer in JSON, including when the request body is not JSON.
// Express's default handler renders an HTML error page, which breaks every
// client that calls res.json() on the response — the failure arrives as a
// parse error in their code rather than as our error message.
app.use((err: any, _req: any, res: any, next: any) => {
  if (!err) return next();
  if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return res.status(400).json({ error: "Request body is not valid JSON." });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body is too large (limit 2mb)." });
  }
  return next(err);
});

// Brute force and runaway loops, not billing: strict on credential guessing,
// loose enough on the API that a busy legitimate adapter never notices.
app.use("/api/auth", rateLimit({ name: "auth", windowMs: 60_000, max: 10 }));
app.use("/v1", rateLimit({ name: "v1", windowMs: 60_000, max: 240, keyFn: apiKeyOrIp }));
app.use("/buzz/connect", rateLimit({ name: "connect", windowMs: 60_000, max: 5 }));

app.use(supabaseAuth); // /auth/supabase/* — 404s unless SUPABASE_URL/ANON_KEY are set
app.use(googleAuth);   // /auth/google — 404s unless GOOGLE_CLIENT_ID/SECRET are set
app.use("/api", api);
app.use("/v1", apiv1);
app.use("/buzz", buzzHook);
app.use("/teams", teamsHook);
app.use("/running/api", runningRouter);

// Remote MCP endpoint — used by Claude.ai connectors
app.all("/mcp", async (req, res) => {
  try {
    await handleMcpRequest(req, res);
  } catch (err: any) {
    console.error("[mcp-http]", err.message);
    if (!res.headersSent) res.status(500).json({ error: "MCP error" });
  }
});

// Proxy for wedding planner → production GroupWisdom API (avoids browser CORS)
app.all("/gw-proxy/*", async (req, res) => {
  const upstream = "https://groupwisdom-v1-production.up.railway.app/v1/" +
    (req.params as any)[0];
  const url = new URL(upstream);
  for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, String(v));
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (req.headers.authorization) headers["Authorization"] = req.headers.authorization;
    const fetchOpts: any = { method: req.method, headers };
    if (req.method !== "GET" && req.method !== "HEAD") {
      fetchOpts.body = JSON.stringify(req.body);
    }
    const upstream_res = await fetch(url.toString(), fetchOpts);
    const data = await upstream_res.json();
    res.status(upstream_res.status).json(data);
  } catch (err: any) {
    res.status(502).json({ error: "Proxy error: " + err.message });
  }
});

// Proxy for the WhatsApp Communities demo → production GroupWisdom API.
// The project-scoped key lives only in WHATSAPP_GW_KEY (server env) and is
// attached here; the browser never sees it and cannot override it.
const WHATSAPP_GW_KEY = process.env.WHATSAPP_GW_KEY || "";
app.all("/whatsapp-api/*", async (req, res) => {
  if (!WHATSAPP_GW_KEY) return res.status(503).json({ error: "WhatsApp demo not configured (missing WHATSAPP_GW_KEY)." });
  const upstream = "https://groupwisdom-v1-production.up.railway.app/v1/" +
    (req.params as any)[0];
  const url = new URL(upstream);
  for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, String(v));
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json", "Authorization": "Bearer " + WHATSAPP_GW_KEY };
    const fetchOpts: any = { method: req.method, headers };
    if (req.method !== "GET" && req.method !== "HEAD") {
      fetchOpts.body = JSON.stringify(req.body);
    }
    const upstream_res = await fetch(url.toString(), fetchOpts);
    const data = await upstream_res.json();
    res.status(upstream_res.status).json(data);
  } catch (err: any) {
    res.status(502).json({ error: "Proxy error: " + err.message });
  }
});

// Proxy for the Research Hub demo → production GroupWisdom API.
// The project-scoped key lives only in RESEARCH_HUB_GW_KEY (server env) and is
// attached here; the browser never sees it and cannot override it.
const RESEARCH_HUB_GW_KEY = process.env.RESEARCH_HUB_GW_KEY || "";
app.all("/research-api/*", async (req, res) => {
  if (!RESEARCH_HUB_GW_KEY) return res.status(503).json({ error: "Research Hub demo not configured (missing RESEARCH_HUB_GW_KEY)." });
  const upstream = "https://groupwisdom-v1-production.up.railway.app/v1/" +
    (req.params as any)[0];
  const url = new URL(upstream);
  for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, String(v));
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json", "Authorization": "Bearer " + RESEARCH_HUB_GW_KEY };
    const fetchOpts: any = { method: req.method, headers };
    if (req.method !== "GET" && req.method !== "HEAD") {
      fetchOpts.body = JSON.stringify(req.body);
    }
    const upstream_res = await fetch(url.toString(), fetchOpts);
    const data = await upstream_res.json();
    res.status(upstream_res.status).json(data);
  } catch (err: any) {
    res.status(502).json({ error: "Proxy error: " + err.message });
  }
});

// Wedding planner AI mode — calls Claude Haiku directly, key never exposed to browser
const HAIKU_KEY = process.env.ANTHROPIC_API_KEY || "";
app.post("/wedding-ai", async (req, res) => {
  const { context } = req.body as { context?: string };
  if (!context) return res.status(400).json({ error: "context required" });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": HAIKU_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1200,
        system: `You are a wedding planning assistant. Analyse the data and return ONLY a valid JSON array (no markdown, no commentary) of 3–5 specific actionable suggestions in this exact shape:
[{"title":"...","body":"...","section":"budget|guests|vendors|timeline|seating"}]
Rules: title ≤ 10 words. body 1–3 sentences, specific to the numbers given. section must be one of the five values.`,
        messages: [{ role: "user", content: context }],
      }),
    });
    const data = await r.json() as any;
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || "Haiku error" });
    const text: string = data.content?.[0]?.text || "[]";
    const match = text.match(/\[[\s\S]*\]/);
    const suggestions = match ? JSON.parse(match[0]) : [];
    res.json({ suggestions });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/docs", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "docs.html"));
});

// Where someone building on the API finds their key. The old workspace used to
// be the only place it appeared, and removing that left no way to get it.
app.get("/account", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "account.html"));
});

app.get("/privacy", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "privacy.html"));
});

app.get("/terms", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "terms.html"));
});

app.get("/running", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "running.html"));
});

app.get("/whatsapp", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "whatsapp.html"));
});

app.get("/buzz", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "buzz.html"));
});

app.get("/research-hub", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "research-hub.html"));
});

// ── Security housekeeping ────────────────────────────────────────────────────
// Encrypt any plaintext rows that predate GW_DATA_KEY (idempotent), then keep
// retention honest: raw Buzz messages live GW_BUZZ_RETENTION_DAYS (default 30,
// 0 disables) — long enough for the engine's short tail, then gone for good.
if (encryptionEnabled()) {
  try {
    const swept = encryptExistingData();
    if (swept.items || swept.blobs) console.log(`[security] encrypted ${swept.items} item(s) and ${swept.blobs} derived record(s) at rest`);
  } catch (err: any) { console.error("[security] encryption sweep failed:", err.message); }
} else {
  console.warn("[security] GW_DATA_KEY not set — content is stored unencrypted. Set it before taking real traffic.");
}

const RETENTION_DAYS = Number(process.env.GW_BUZZ_RETENTION_DAYS ?? 30);
function runRetention() {
  try {
    const pruned = pruneOldBuzzItems(RETENTION_DAYS);
    const gates = pruneOldGateRecords(90);
    if (pruned || gates) console.log(`[security] retention: deleted ${pruned} old message(s), ${gates} old gate record(s)`);
  } catch (err: any) { console.error("[security] retention failed:", err.message); }
}
runRetention();
setInterval(runRetention, 6 * 60 * 60 * 1000).unref();

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`GroupWisdom running at http://localhost:${port}`);
  console.log(`Insight engine: ${process.env.ANTHROPIC_API_KEY ? "Claude API (" + (process.env.GW_MODEL || "claude-sonnet-4-6") + ")" : "mock mode (set ANTHROPIC_API_KEY for real analysis)"}`);
  // Reconnect every Buzz community that has been connected. No-op when none are.
  try { startBuzzSupervisor(); } catch (err: any) { console.error("[buzz] supervisor failed to start:", err.message); }
});
