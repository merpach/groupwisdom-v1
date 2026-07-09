/**
 * GroupWisdom public API — v1
 * Mounted at /v1 alongside the existing /api routes (nothing removed).
 *
 * Auth: Authorization: Bearer <key>
 *   - Personal key (gw_...): access all your projects
 *   - Project key (gw_proj_...): access one specific project only
 *
 * Endpoints:
 *   POST   /v1/projects                       — create a project
 *   GET    /v1/projects                       — list your projects
 *   GET    /v1/projects/:id                   — get project + counts
 *   PATCH  /v1/projects/:id                   — update name / webhook_url
 *   POST   /v1/projects/:id/ingest            — send items (bulk ok), triggers analysis
 *   GET    /v1/projects/:id/items             — list items (paginated)
 *   DELETE /v1/projects/:id/items/:itemId     — delete an item
 *   GET    /v1/projects/:id/insights          — get current insights (paginated)
 *   POST   /v1/projects/:id/keys              — create a project API key
 *   GET    /v1/projects/:id/keys              — list project API keys
 *   DELETE /v1/projects/:id/keys/:keyId       — revoke a project API key
 */
import { createHmac } from "node:crypto";
import { Router } from "express";
import {
  getUserByApiKey,
  getUserByEmail,
  getGroupsForUser,
  getGroup,
  createGroup,
  addMember,
  listMembers,
  addItem,
  listItems,
  listItemsPaginated,
  listInsightsPaginated,
  listInsights,
  deleteItem,
  getGroupWebhook,
  getGroupWebhookSecret,
  setGroupWebhook,
  createProjectApiKey,
  listProjectApiKeys,
  getByProjectApiKey,
  revokeProjectApiKey,
  getUserUsagePct,
  type Item,
  type Group,
  type User,
} from "./db.js";
import { queueIncrementalAnalysis, updateProjectSummary } from "./engine.js";

export const apiv1 = Router();

let notify: (groupId: string, event: string) => void = () => {};
export const setV1Notifier = (fn: typeof notify) => { notify = fn; };

// ── Auth ──────────────────────────────────────────────────────────────────────

type AuthResult =
  | { kind: "user"; user: User; projectId: null }
  | { kind: "project_key"; user: null; projectId: string };

function auth(req: any): AuthResult | null {
  const header = req.headers.authorization ?? "";
  const key = header.replace(/^Bearer\s+/i, "").trim() || (req.query.key as string);
  if (!key) return null;

  if (key.startsWith("gw_proj_")) {
    const pk = getByProjectApiKey(key);
    if (!pk) return null;
    return { kind: "project_key", user: null, projectId: pk.project_id };
  }

  const user = getUserByApiKey(key);
  if (!user) return null;
  return { kind: "user", user, projectId: null };
}

function resolveProject(req: any, authResult: AuthResult): Group | undefined {
  const g = getGroup(req.params.id);
  if (!g) return undefined;

  if (authResult.kind === "project_key") {
    return authResult.projectId === g.id ? g : undefined;
  }

  const isMember = listMembers(g.id).some(m => m.user_id === authResult.user!.id);
  return isMember ? g : undefined;
}

function getUserId(authResult: AuthResult): string | null {
  return authResult.kind === "user" ? authResult.user.id : null;
}

// ── Insight views ─────────────────────────────────────────────────────────────

function insightSimple(ins: any) { return { id: ins.id, title: ins.title, body: ins.body }; }
function insightFull(ins: any) { return { id: ins.id, kind: ins.kind, title: ins.title, body: ins.body, status: ins.status, created_at: ins.created_at }; }

// ── Webhook ───────────────────────────────────────────────────────────────────

async function fireWebhook(groupId: string, insights: any[]) {
  const url = getGroupWebhook(groupId);
  if (!url) return;
  const secret = getGroupWebhookSecret(groupId);
  const body = JSON.stringify({ event: "insights.created", group_id: groupId, insights: insights.map(insightSimple) });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) {
    headers["X-GroupWisdom-Signature"] = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  }
  try {
    await fetch(url, { method: "POST", headers, body });
  } catch (err: any) {
    console.error("[webhook] delivery failed:", err.message);
  }
}

// ── View helpers ──────────────────────────────────────────────────────────────

function projectView(groupId: string) {
  const g = getGroup(groupId)!;
  const items = listItems(groupId);
  const insights = listInsights(groupId);
  return {
    id: g.id,
    name: g.name,
    created_at: g.created_at,
    webhook_url: getGroupWebhook(groupId),
    counts: { items: items.length, insights: insights.length },
  };
}

function parsePagination(query: any) {
  const limit = Math.min(Math.max(parseInt(query.limit ?? "50", 10) || 50, 1), 200);
  const offset = Math.max(parseInt(query.offset ?? "0", 10) || 0, 0);
  return { limit, offset };
}

// ── Demo ─────────────────────────────────────────────────────────────────────
// Creates a throwaway project + project key so anyone can try the API without signing up.

apiv1.post("/demo", (req, res) => {
  const demoUser = getUserByEmail("demo@groupwisdom.internal");
  if (!demoUser) return res.status(503).json({ error: "Demo unavailable." });
  const g = createGroup("Demo — " + new Date().toISOString().slice(0, 16).replace("T", " "));
  addMember(g.id, "Demo", "", demoUser.email, demoUser.id);
  const pk = createProjectApiKey(g.id, "demo");
  res.status(201).json({
    project_id: g.id,
    api_key: pk.key,
    base_url: (req.headers["x-forwarded-proto"] ?? req.protocol) + "://" + req.headers.host + "/v1",
  });
});

// ── Usage ─────────────────────────────────────────────────────────────────────

apiv1.get("/usage", (req, res) => {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: "Invalid or missing API key." });
  if (a.kind === "project_key") return res.status(403).json({ error: "Use your personal API key to check usage." });
  const pct = getUserUsagePct(a.user!.id);
  res.json({ percent_used: pct, limit_reached: pct >= 100 });
});

// ── Projects ──────────────────────────────────────────────────────────────────

apiv1.post("/projects", (req, res) => {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: "Invalid or missing API key." });
  if (a.kind === "project_key") return res.status(403).json({ error: "Project keys cannot create new projects. Use your personal API key." });
  const name = (req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name is required." });
  const g = createGroup(name);
  addMember(g.id, a.user!.name, "", a.user!.email, a.user!.id);
  if (req.body?.webhook_url) setGroupWebhook(g.id, req.body.webhook_url);
  res.status(201).json(projectView(g.id));
});

apiv1.get("/projects", (req, res) => {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: "Invalid or missing API key." });
  if (a.kind === "project_key") return res.status(403).json({ error: "Project keys are scoped to one project. Use your personal API key to list all projects." });
  const groups = getGroupsForUser(a.user!.id);
  res.json(groups.map(g => projectView(g.id)));
});

apiv1.get("/projects/:id", (req, res) => {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: "Invalid or missing API key." });
  const g = resolveProject(req, a);
  if (!g) return res.status(404).json({ error: "Project not found." });
  res.json(projectView(g.id));
});

apiv1.patch("/projects/:id", (req, res) => {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: "Invalid or missing API key." });
  const g = resolveProject(req, a);
  if (!g) return res.status(404).json({ error: "Project not found." });
  let webhookSecret: string | null | undefined;
  if ("webhook_url" in req.body) webhookSecret = setGroupWebhook(g.id, req.body.webhook_url || null);
  const view = projectView(g.id);
  res.json(webhookSecret ? { ...view, webhook_secret: webhookSecret } : view);
});

// ── Ingest ────────────────────────────────────────────────────────────────────

apiv1.post("/projects/:id/ingest", (req, res) => {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: "Invalid or missing API key." });
  const g = resolveProject(req, a);
  if (!g) return res.status(404).json({ error: "Project not found." });

  const raw = req.body;
  const payloads: any[] = Array.isArray(raw) ? raw : raw?.items ? raw.items : [raw];
  if (!payloads.length) return res.status(400).json({ error: "Provide one item or an items array." });

  const memberCache = new Map<string, ReturnType<typeof listMembers>[0]>();
  const existingMembers = listMembers(g.id);
  const userId = getUserId(a);
  const ownerMember = userId ? (existingMembers.find(m => m.user_id === userId) ?? null) : null;

  function resolveMember(contributedBy?: string) {
    if (!contributedBy) return ownerMember;
    const key = contributedBy.trim().toLowerCase();
    if (memberCache.has(key)) return memberCache.get(key)!;
    const existing = existingMembers.find(m => m.name.toLowerCase() === key);
    if (existing) { memberCache.set(key, existing); return existing; }
    const created = addMember(g!.id, contributedBy.trim(), "", "");
    existingMembers.push(created);
    memberCache.set(key, created);
    return created;
  }

  const created: Item[] = [];
  for (const p of payloads) {
    if (!p.title && !p.content && !p.url) continue;
    const member = resolveMember(p.contributed_by);
    const item = addItem(g.id, {
      title: p.title || p.url || String(p.content ?? "").slice(0, 60),
      content: p.content ?? "",
      url: p.url ?? "",
      type: p.type ?? (p.url ? "link" : "note"),
      source: "api",
      member_id: member?.id ?? null,
    });
    created.push(item);
    queueIncrementalAnalysis(g.id, item, async (insights) => {
      notify(g.id, "update");
      if (insights?.length) await fireWebhook(g.id, insights);
    });
  }

  updateProjectSummary(g.id).catch(err => console.error("[summary]", err.message));
  notify(g.id, "update");

  res.status(202).json({
    accepted: created.length,
    items: created.map(i => ({ id: i.id, title: i.title, type: i.type })),
    message: "Items queued for analysis. Insights will be POSTed to your webhook_url when ready.",
  });
});

// ── Items ─────────────────────────────────────────────────────────────────────

apiv1.get("/projects/:id/items", (req, res) => {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: "Invalid or missing API key." });
  const g = resolveProject(req, a);
  if (!g) return res.status(404).json({ error: "Project not found." });
  const { limit, offset } = parsePagination(req.query);
  res.json(listItemsPaginated(g.id, limit, offset));
});

apiv1.delete("/projects/:id/items/:itemId", (req, res) => {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: "Invalid or missing API key." });
  const g = resolveProject(req, a);
  if (!g) return res.status(404).json({ error: "Project not found." });
  const items = listItems(g.id);
  if (!items.find(i => i.id === req.params.itemId)) return res.status(404).json({ error: "Item not found." });
  deleteItem(req.params.itemId);
  res.json({ deleted: true, id: req.params.itemId });
});

// ── Insights ──────────────────────────────────────────────────────────────────

apiv1.get("/projects/:id/insights", (req, res) => {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: "Invalid or missing API key." });
  const g = resolveProject(req, a);
  if (!g) return res.status(404).json({ error: "Project not found." });
  const { limit, offset } = parsePagination(req.query);
  const kind = req.query.kind as string | undefined;
  const full = req.query.format === "full";
  const result = listInsightsPaginated(g.id, kind, limit, offset);
  const view = full ? insightFull : insightSimple;
  res.json({ ...result, data: result.data.map(view) });
});

// ── Project API Keys ──────────────────────────────────────────────────────────

apiv1.post("/projects/:id/keys", (req, res) => {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: "Invalid or missing API key." });
  if (a.kind === "project_key") return res.status(403).json({ error: "Use your personal API key to manage project keys." });
  const g = resolveProject(req, a);
  if (!g) return res.status(404).json({ error: "Project not found." });
  const name = (req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name is required." });
  const pk = createProjectApiKey(g.id, name);
  res.status(201).json({ id: pk.id, name: pk.name, key: pk.key, created_at: pk.created_at });
});

apiv1.get("/projects/:id/keys", (req, res) => {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: "Invalid or missing API key." });
  if (a.kind === "project_key") return res.status(403).json({ error: "Use your personal API key to manage project keys." });
  const g = resolveProject(req, a);
  if (!g) return res.status(404).json({ error: "Project not found." });
  const keys = listProjectApiKeys(g.id).map(k => ({
    id: k.id, name: k.name,
    key_preview: k.key.slice(0, 12) + "...",
    created_at: k.created_at,
    last_used_at: k.last_used_at,
  }));
  res.json(keys);
});

apiv1.delete("/projects/:id/keys/:keyId", (req, res) => {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: "Invalid or missing API key." });
  if (a.kind === "project_key") return res.status(403).json({ error: "Use your personal API key to manage project keys." });
  const g = resolveProject(req, a);
  if (!g) return res.status(404).json({ error: "Project not found." });
  const keys = listProjectApiKeys(g.id);
  if (!keys.find(k => k.id === req.params.keyId)) return res.status(404).json({ error: "Key not found." });
  revokeProjectApiKey(req.params.keyId);
  res.json({ revoked: true, id: req.params.keyId });
});
