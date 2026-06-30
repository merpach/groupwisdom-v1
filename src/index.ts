import express from "express";
import session from "express-session";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import bcrypt from "bcrypt";
import { api, setNotifier } from "./api.js";
import { apiv1, setV1Notifier } from "./api-v1.js";
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

// Remote MCP endpoint — used by Claude.ai connectors
app.all("/mcp", async (req, res) => {
  try {
    await handleMcpRequest(req, res);
  } catch (err: any) {
    console.error("[mcp-http]", err.message);
    if (!res.headersSent) res.status(500).json({ error: "MCP error" });
  }
});

app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/docs", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "docs.html"));
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`GroupWisdom running at http://localhost:${port}`);
  console.log(`Insight engine: ${process.env.ANTHROPIC_API_KEY ? "Claude API (" + (process.env.GW_MODEL || "claude-sonnet-4-6") + ")" : "mock mode (set ANTHROPIC_API_KEY for real analysis)"}`);
});
