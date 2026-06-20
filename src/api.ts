import { Router } from "express";
import multer from "multer";
import bcrypt from "bcrypt";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
import {
  createGroup, getGroup, getGroupByKey, listGroups, deleteGroup,
  addMember, listMembers, getMemberByToken, getGroupsForMember, getGroupsByToken,
  createUser, getUserByEmail, getUserById, getUserByApiKey, getGroupsForUser,
  addItem, listItems, searchItems,
  listInsights, setInsightStatus,
  listConnectors, setConnectorStatus, touchConnector,
  getKnowledgeDoc,
  createInvite, getInviteByToken, acceptInvite,
  getProjectSummary,
  listUserContexts,
} from "./db.js";
import { analyzeGroup, previewAnalysis, acceptInsight, updateProjectSummary } from "./engine.js";

export const api = Router();

let notify: (groupId: string, event: string) => void = () => {};
export const setNotifier = (fn: typeof notify) => { notify = fn; };

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

async function extractText(file: Express.Multer.File): Promise<string> {
  if (file.mimetype === "application/pdf") {
    const data = await pdfParse(file.buffer);
    return data.text.trim();
  }
  if (file.mimetype.startsWith("text/") || /\.(md|txt|csv|json|ts|js|py)$/.test(file.originalname)) {
    return file.buffer.toString("utf8").trim();
  }
  return "";
}

/** Get the logged-in user from session or personal API key header. */
function getUser(req: any) {
  if (req.session?.userId) return getUserById(req.session.userId);
  const key = req.header("x-api-key");
  if (key) return getUserByApiKey(key);
  return undefined;
}

/** Resolve group — checks user membership for browser calls, group api key for MCP. */
function resolveGroup(req: any) {
  const groupApiKey = req.header("x-api-key");
  if (groupApiKey) {
    const byGroup = getGroupByKey(groupApiKey);
    if (byGroup) return byGroup;
  }
  const user = getUser(req);
  if (!user) return undefined;
  const g = req.params.id ? getGroup(req.params.id) : undefined;
  if (!g) return undefined;
  const isMember = listMembers(g.id).some(m => m.user_id === user.id);
  return isMember ? g : undefined;
}

// ── Auth routes ────────────────────────────────────────────────────────────────

api.post("/auth/signup", async (req, res) => {
  const { name, email, password } = req.body ?? {};
  if (!name?.trim() || !email?.trim() || !password) return res.status(400).json({ error: "name, email and password required" });
  if (getUserByEmail(email)) return res.status(409).json({ error: "An account with that email already exists" });
  const hash = await bcrypt.hash(password, 10);
  const user = createUser(email, hash, name.trim());
  req.session.userId = user.id;
  res.status(201).json({ id: user.id, name: user.name, email: user.email, api_key: user.api_key });
});

api.post("/auth/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  const user = getUserByEmail(email);
  if (!user) return res.status(401).json({ error: "No account found with that email" });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Incorrect password" });
  req.session.userId = user.id;
  res.json({ id: user.id, name: user.name, email: user.email, api_key: user.api_key });
});

api.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {});
  res.json({ ok: true });
});

api.get("/me", (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "not logged in" });
  res.json({ id: user.id, name: user.name, email: user.email, api_key: user.api_key });
});

api.get("/groups", (req, res) => {
  const user = getUser(req);
  if (!user) return res.json([]);
  const groups = getGroupsForUser(user.id).map(({ api_key, ...g }) => g);
  res.json(groups);
});

api.post("/groups", (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "not logged in" });
  const name = (req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  const g = createGroup(name);
  addMember(g.id, user.name, "", user.email, user.id);
  res.status(201).json(g);
});

api.get("/groups/:id", (req, res) => {
  const g = resolveGroup(req);
  if (!g) return res.status(404).json({ error: "group not found" });
  const contextByUser = Object.fromEntries(
    listUserContexts(g.id).map(c => [c.user_id, c.updated_at])
  );
  const members = listMembers(g.id).map(m => ({
    ...m,
    context_updated_at: m.user_id ? (contextByUser[m.user_id] ?? null) : null,
  }));
  res.json({
    ...g,
    members,
    connectors: listConnectors(g.id),
    counts: { items: listItems(g.id).length, insights: listInsights(g.id).length },
    summary: getProjectSummary(g.id),
  });
});

api.get("/groups/:id/members", (req, res) => {
  const g = resolveGroup(req);
  if (!g) return res.status(404).json({ error: "group not found" });
  res.json(listMembers(g.id));
});

api.post("/groups/:id/members", (req, res) => {
  const g = resolveGroup(req);
  if (!g) return res.status(404).json({ error: "group not found" });
  const { name, role, email } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name required" });
  res.status(201).json(addMember(g.id, name, role ?? "", email ?? ""));
});

api.get("/groups/:id/items", (req, res) => {
  const g = resolveGroup(req);
  if (!g) return res.status(404).json({ error: "group not found" });
  const q = req.query.q as string | undefined;
  res.json(q ? searchItems(g.id, q) : listItems(g.id));
});

api.post("/groups/:id/items", async (req, res) => {
  const g = resolveGroup(req);
  if (!g) return res.status(404).json({ error: "group not found" });
  const { title, content, url, type, member_id, source } = req.body ?? {};
  if (!title && !content && !url) return res.status(400).json({ error: "title, content or url required" });
  const item = addItem(g.id, {
    title: title || url || String(content).slice(0, 60),
    content, url, type, member_id,
    source: source ?? (req.header("x-api-key") ? "api" : "web"),
  });
  if (source === "mcp") touchConnector(g.id, "Claude");
  notify(g.id, "update");
  analyzeGroup(g.id).catch(err => console.error("[engine]", err.message));
  updateProjectSummary(g.id).catch(err => console.error("[summary]", err.message));
  res.status(201).json(item);
});

api.get("/groups/:id/insights", (req, res) => {
  const g = resolveGroup(req);
  if (!g) return res.status(404).json({ error: "group not found" });
  res.json(listInsights(g.id, req.query.kind as string | undefined));
});

api.post("/groups/:id/insights/:insightId/react", (req, res) => {
  const g = resolveGroup(req);
  if (!g) return res.status(404).json({ error: "group not found" });
  const status = req.body?.status;
  if (!["acknowledged", "dismissed", "new"].includes(status))
    return res.status(400).json({ error: "status must be acknowledged | dismissed | new" });
  setInsightStatus(req.params.insightId, status);
  res.json({ ok: true });
});

api.get("/groups/:id/knowledge", (req, res) => {
  const g = resolveGroup(req);
  if (!g) return res.status(404).json({ error: "group not found" });
  res.json({ ...getKnowledgeDoc(g.id), sources: listItems(g.id).length });
});

api.post("/groups/:id/analyze", async (req, res) => {
  const g = resolveGroup(req);
  if (!g) return res.status(404).json({ error: "group not found" });
  const created = await analyzeGroup(g.id);
  res.json({ created: created.length, insights: created });
});

api.get("/groups/:id/analyze/preview", async (req, res) => {
  const g = resolveGroup(req);
  if (!g) return res.status(404).json({ error: "group not found" });
  const proposals = await previewAnalysis(g.id);
  res.json(proposals);
});

api.post("/groups/:id/insights", async (req, res) => {
  const g = resolveGroup(req);
  if (!g) return res.status(404).json({ error: "group not found" });
  const { kind, title, body } = req.body ?? {};
  if (!kind || !title || !body) return res.status(400).json({ error: "kind, title, body required" });
  const insight = await acceptInsight(g.id, kind, title, body);
  setInsightStatus(insight.id, "acknowledged");
  insight.status = "acknowledged";
  notify(g.id, "update");
  res.status(201).json(insight);
});

api.delete("/groups/:id", (req, res) => {
  const g = resolveGroup(req);
  if (!g) return res.status(404).json({ error: "group not found" });
  deleteGroup(g.id);
  res.json({ ok: true });
});

api.post("/groups/:id/connectors/:connectorId", (req, res) => {
  const g = resolveGroup(req);
  if (!g) return res.status(404).json({ error: "group not found" });
  const status = req.body?.status;
  if (!["connected", "available"].includes(status))
    return res.status(400).json({ error: "status must be connected | available" });
  setConnectorStatus(req.params.connectorId, status);
  res.json({ ok: true });
});

api.post("/groups/:id/invites", (req, res) => {
  const g = resolveGroup(req);
  if (!g) return res.status(404).json({ error: "group not found" });
  const email = (req.body?.email ?? "").trim();
  const invite = createInvite(g.id, email);
  const host = req.headers.host ?? "localhost:3000";
  const url = `http://${host}/api/invite/${invite.token}`;
  res.status(201).json({ url, token: invite.token, email });
});

api.get("/invite/:token", (req, res) => {
  const invite = getInviteByToken(req.params.token);
  if (!invite) return res.status(404).send("Invite link not found or expired.");
  const group = getGroup(invite.group_id);
  if (!group) return res.status(404).send("Group not found.");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join ${group.name} on GroupWisdom</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,sans-serif; background:#fff; color:#111; display:flex; align-items:center; justify-content:center; min-height:100vh; }
  .box { max-width:400px; width:100%; padding:40px 32px; border:1px solid #e8e8e8; border-radius:12px; margin:24px; }
  h1 { font-size:20px; font-weight:600; margin-bottom:8px; }
  p { color:#666; font-size:14px; margin-bottom:24px; line-height:1.5; }
  input { width:100%; font:inherit; font-size:14px; padding:10px 12px; border:1px solid #e0e0e0; border-radius:8px; background:#fafafa; margin-bottom:10px; }
  input:focus { outline:none; border-color:#aaa; background:#fff; }
  button { width:100%; font:inherit; font-size:14px; padding:10px; border-radius:8px; border:none; background:#111; color:#fff; cursor:pointer; }
  button:hover { background:#333; }
  .err { color:#e5484d; font-size:13px; margin-top:8px; }
</style>
</head>
<body>
<div class="box">
  <h1>You're invited to join<br>${group.name}</h1>
  <p>Enter your name to join this GroupWisdom project. You'll be able to add notes, links, files, and use all AI features.</p>
  <input id="name" placeholder="Your name" autofocus>
  <input id="role" placeholder="Your role (optional)">
  <button onclick="join()">Join project</button>
  <div class="err" id="err"></div>
</div>
<script>
async function join() {
  const name = document.getElementById('name').value.trim();
  if (!name) { document.getElementById('err').textContent = 'Please enter your name.'; return; }
  const r = await fetch('/api/invite/${invite.token}/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, role: document.getElementById('role').value.trim() }),
  });
  const data = await r.json();
  if (!r.ok) { document.getElementById('err').textContent = data.error; return; }
  localStorage.setItem('gw_group', data.group_id);
  localStorage.setItem('gw_member', data.member_id);
  localStorage.setItem('gw_member_token', data.member_token);
  localStorage.setItem('gw_user_name', name);
  window.location.href = '/';
}
document.getElementById('name').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
</script>
</body>
</html>`);
});

api.post("/invite/:token/accept", (req, res) => {
  const invite = getInviteByToken(req.params.token);
  if (!invite) return res.status(404).json({ error: "Invite not found." });
  const group = getGroup(invite.group_id);
  if (!group) return res.status(404).json({ error: "Group not found." });
  const user = getUser(req);
  const { name, role } = req.body ?? {};
  const memberName = user?.name ?? name?.trim();
  if (!memberName) return res.status(400).json({ error: "Name required." });
  const member = addMember(group.id, memberName, role ?? "", user?.email ?? "", user?.id);
  acceptInvite(req.params.token);
  res.json({ group_id: group.id, member_id: member.id, group_name: group.name });
});

api.post("/groups/:id/upload", upload.array("files"), async (req, res) => {
  const g = resolveGroup(req);
  if (!g) return res.status(404).json({ error: "group not found" });
  const files = req.files as Express.Multer.File[];
  if (!files?.length) return res.status(400).json({ error: "no files" });
  const created = await Promise.all(files.map(async file => {
    const content = await extractText(file).catch(() => "");
    const item = addItem(g.id, {
      type: "file",
      title: file.originalname,
      content: content.slice(0, 8000),
      source: "web",
      member_id: (req.body?.member_id as string) || null,
    });
    return item;
  }));
  notify(g.id, "update");
  analyzeGroup(g.id).catch(err => console.error("[engine]", err.message));
  res.status(201).json({ created: created.length, items: created });
});
