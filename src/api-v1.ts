/**
 * GroupWisdom public API — v1
 * Mounted at /v1 alongside the existing /api routes (nothing removed).
 *
 * Auth: Authorization: Bearer USER_API_KEY  (same key from /api/me)
 * All responses are JSON. Errors: { error: string }
 *
 * Endpoints:
 *   POST   /v1/projects                  — create a project
 *   GET    /v1/projects                  — list your projects
 *   GET    /v1/projects/:id              — get project + counts
 *   PATCH  /v1/projects/:id             — update name / webhook_url
 *   POST   /v1/projects/:id/ingest      — send items (bulk ok), triggers analysis
 *   GET    /v1/projects/:id/items       — list items
 *   GET    /v1/projects/:id/insights    — get current insights
 */
import { Router } from "express";
import {
  getUserByApiKey,
  getGroupsForUser,
  getGroup,
  createGroup,
  addMember,
  listMembers,
  addItem,
  listItems,
  listInsights,
  getGroupWebhook,
  setGroupWebhook,
  type Item,
} from "./db.js";
import { queueIncrementalAnalysis, updateProjectSummary } from "./engine.js";

export const apiv1 = Router();

let notify: (groupId: string, event: string) => void = () => {};
export const setV1Notifier = (fn: typeof notify) => { notify = fn; };

function auth(req: any): ReturnType<typeof getUserByApiKey> {
  const header = req.headers.authorization ?? "";
  const key = header.replace(/^Bearer\s+/i, "").trim() || (req.query.key as string);
  if (!key) return undefined;
  return getUserByApiKey(key);
}

function resolveProject(req: any, userId: string) {
  const g = getGroup(req.params.id);
  if (!g) return undefined;
  const isMember = listMembers(g.id).some(m => m.user_id === userId);
  return isMember ? g : undefined;
}

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

// ── Projects ──────────────────────────────────────────────────────────────────

apiv1.post("/projects", (req, res) => {
  const user = auth(req);
  if (!user) return res.status(401).json({ error: "Invalid or missing API key." });
  const name = (req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name is required." });
  const g = createGroup(name);
  addMember(g.id, user.name, "", user.email, user.id);
  if (req.body?.webhook_url) setGroupWebhook(g.id, req.body.webhook_url);
  res.status(201).json(projectView(g.id));
});

apiv1.get("/projects", (req, res) => {
  const user = auth(req);
  if (!user) return res.status(401).json({ error: "Invalid or missing API key." });
  const groups = getGroupsForUser(user.id);
  res.json(groups.map(g => projectView(g.id)));
});

apiv1.get("/projects/:id", (req, res) => {
  const user = auth(req);
  if (!user) return res.status(401).json({ error: "Invalid or missing API key." });
  const g = resolveProject(req, user.id);
  if (!g) return res.status(404).json({ error: "Project not found." });
  res.json(projectView(g.id));
});

apiv1.patch("/projects/:id", (req, res) => {
  const user = auth(req);
  if (!user) return res.status(401).json({ error: "Invalid or missing API key." });
  const g = resolveProject(req, user.id);
  if (!g) return res.status(404).json({ error: "Project not found." });
  if ("webhook_url" in req.body) setGroupWebhook(g.id, req.body.webhook_url || null);
  res.json(projectView(g.id));
});

// ── Ingest ────────────────────────────────────────────────────────────────────

apiv1.post("/projects/:id/ingest", (req, res) => {
  const user = auth(req);
  if (!user) return res.status(401).json({ error: "Invalid or missing API key." });
  const g = resolveProject(req, user.id);
  if (!g) return res.status(404).json({ error: "Project not found." });

  const raw = req.body;
  // Accept either a single item object or an array
  const payloads: any[] = Array.isArray(raw) ? raw : raw?.items ? raw.items : [raw];

  if (!payloads.length) return res.status(400).json({ error: "Provide one item or an items array." });

  // Cache of name → member so we only look up / create once per ingest call
  const memberCache = new Map<string, ReturnType<typeof listMembers>[0]>();
  const existingMembers = listMembers(g.id);
  const ownerMember = existingMembers.find(m => m.user_id === user.id) ?? null;

  function resolveMember(contributedBy?: string) {
    if (!contributedBy) return ownerMember;
    const key = contributedBy.trim().toLowerCase();
    if (memberCache.has(key)) return memberCache.get(key)!;
    // Find existing member by name (case-insensitive)
    const existing = existingMembers.find(m => m.name.toLowerCase() === key);
    if (existing) { memberCache.set(key, existing); return existing; }
    // Auto-create — no login, no invite needed, just a name on the data
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
    // Queue incremental analysis per item (debounced, fires once for the batch)
    queueIncrementalAnalysis(g.id, item, () => notify(g.id, "update"));
  }

  updateProjectSummary(g.id).catch(err => console.error("[summary]", err.message));
  notify(g.id, "update");

  res.status(202).json({
    accepted: created.length,
    items: created.map(i => ({ id: i.id, title: i.title, type: i.type })),
    message: "Items queued for analysis. Insights will be POSTed to your webhook_url when ready.",
  });
});

// ── Read ──────────────────────────────────────────────────────────────────────

apiv1.get("/projects/:id/items", (req, res) => {
  const user = auth(req);
  if (!user) return res.status(401).json({ error: "Invalid or missing API key." });
  const g = resolveProject(req, user.id);
  if (!g) return res.status(404).json({ error: "Project not found." });
  res.json(listItems(g.id));
});

apiv1.get("/projects/:id/insights", (req, res) => {
  const user = auth(req);
  if (!user) return res.status(401).json({ error: "Invalid or missing API key." });
  const g = resolveProject(req, user.id);
  if (!g) return res.status(404).json({ error: "Project not found." });
  const kind = req.query.kind as string | undefined;
  res.json(listInsights(g.id, kind));
});
