import express from "express";
import session from "express-session";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import bcrypt from "bcrypt";
import { api, setNotifier } from "./api.js";
import { apiv1, setV1Notifier } from "./api-v1.js";
import { runningRouter, CLUB_GROUP_ID } from "./running.js";
import { handleMcpRequest } from "./mcp-http.js";
import { getUserByEmail, createUser } from "./db.js";

// Ensure demo user exists for the /v1/demo endpoint
const DEMO_EMAIL = "demo@groupwisdom.internal";
if (!getUserByEmail(DEMO_EMAIL)) {
  createUser(DEMO_EMAIL, await bcrypt.hash("no-login-" + Math.random(), 10), "Demo");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);

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

app.use(session({
  secret: process.env.SESSION_SECRET || "gw-dev-secret-change-in-prod",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 days
}));
app.use(express.json({ limit: "2mb" }));
app.use("/api", api);
app.use("/v1", apiv1);
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

app.get("/running", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "running.html"));
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`GroupWisdom running at http://localhost:${port}`);
  console.log(`Insight engine: ${process.env.ANTHROPIC_API_KEY ? "Claude API (" + (process.env.GW_MODEL || "claude-sonnet-4-6") + ")" : "mock mode (set ANTHROPIC_API_KEY for real analysis)"}`);
});
