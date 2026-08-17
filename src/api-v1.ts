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
 *   GET    /v1/projects/:id/wisdom            — get current wisdom (paginated)
 *   GET    /v1/projects/:id/insights          — the same, under its former name
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
  deleteGroup,
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
  getGroupEngine,
  setGroupEngine,
  createProjectApiKey,
  listProjectApiKeys,
  getByProjectApiKey,
  revokeProjectApiKey,
  getUserUsagePct,
  listGateRecords,
  getGroupMemoryRaw,
  renameContributor,
  getInsight,
  recordWisdomFeedback,
  withdrawWisdomFeedback,
  getFeedbackBySourceEvent,
  listWisdomFeedback,
  feedbackSummary,
  VERDICTS,
  type WisdomVerdict,
  type Item,
  type Group,
  type User,
} from "./db.js";
import { queueIncrementalAnalysis, updateProjectSummary, analyzeGroup, cancelPendingAnalysis } from "./engine.js";

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

// ── Wisdom views ──────────────────────────────────────────────────────────────

function wisdomSimple(w: any) { return { id: w.id, title: w.title, body: w.body }; }
function wisdomFull(w: any) { return { id: w.id, kind: w.kind, title: w.title, body: w.body, status: w.status, created_at: w.created_at, confidence: w.confidence ?? null, caveat: w.caveat ?? null, do_next: w.do_next ?? null, missing_voice: w.missing_voice ?? null }; }

// ── Webhook ───────────────────────────────────────────────────────────────────

async function fireWebhook(groupId: string, wisdom: any[]) {
  const url = getGroupWebhook(groupId);
  if (!url) return;
  const secret = getGroupWebhookSecret(groupId);
  // `wisdom` is the documented field. `insights` carries the identical array
  // and `event` keeps its original value, because a receiver matching on
  // "insights.created" or reading payload.insights is code we would otherwise
  // break from the outside, with no warning and no way for them to prepare.
  const payload = wisdom.map(wisdomFull);
  const body = JSON.stringify({ event: "insights.created", group_id: groupId, wisdom: payload, insights: payload });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) {
    headers["X-GroupWisdom-Signature"] = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  }
  const delays = [0, 5000, 30000];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await new Promise(r => setTimeout(r, delays[attempt]));
    try {
      const res = await fetch(url, { method: "POST", headers, body });
      if (res.ok) return;
      console.warn(`[webhook] attempt ${attempt + 1} got ${res.status} — ${attempt < delays.length - 1 ? "retrying" : "giving up"}`);
    } catch (err: any) {
      console.warn(`[webhook] attempt ${attempt + 1} failed: ${err.message} — ${attempt < delays.length - 1 ? "retrying" : "giving up"}`);
    }
  }
}

// ── View helpers ──────────────────────────────────────────────────────────────

function projectView(groupId: string) {
  const g = getGroup(groupId)!;
  const items = listItems(groupId);
  const wisdom = listInsights(groupId);
  return {
    id: g.id,
    name: g.name,
    created_at: g.created_at,
    webhook_url: getGroupWebhook(groupId),
    engine: getGroupEngine(groupId),
    // counts.insights is the old key, kept beside the new one for the same
    // reason as the webhook: someone is reading it today.
    counts: { items: items.length, wisdom: wisdom.length, insights: wisdom.length },
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

// ── Analyze ──────────────────────────────────────────────────────────────────
// Triggers the full two-pass analysis (Pass 1 + metacognitive Pass 2) on demand.

apiv1.post("/projects/:id/analyze", (req, res) => {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: "Invalid or missing API key." });
  const g = resolveProject(req, a);
  if (!g) return res.status(404).json({ error: "Project not found." });
  cancelPendingAnalysis(g.id); // prevent incremental from racing and saving wisdom without review-pass data
  res.status(202).json({ message: "Analysis started." });
  analyzeGroup(g.id).catch(err => console.error("[analyze]", err.message));
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
  if (req.body?.engine && ["claude", "muse-spark"].includes(req.body.engine)) setGroupEngine(g.id, req.body.engine);
  const view = projectView(g.id);
  res.json(webhookSecret ? { ...view, webhook_secret: webhookSecret } : view);
});

apiv1.delete("/projects/:id", (req, res) => {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: "Invalid or missing API key." });
  if (a.kind === "project_key") return res.status(403).json({ error: "Use your personal API key to delete projects." });
  const g = resolveProject(req, a);
  if (!g) return res.status(404).json({ error: "Project not found." });
  deleteGroup(g.id);
  res.json({ deleted: true, id: g.id });
});

apiv1.post("/projects/:id/test-webhook", async (req, res) => {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: "Invalid or missing API key." });
  const g = resolveProject(req, a);
  if (!g) return res.status(404).json({ error: "Project not found." });
  const url = getGroupWebhook(g.id);
  if (!url) return res.status(400).json({ error: "No webhook URL set for this project." });
  const secret = getGroupWebhookSecret(g.id);
  const sample = [{ id: "test-wisdom", title: "Webhook is working", body: "This is a test event from GroupWisdom." }];
  const body = JSON.stringify({ event: "test", group_id: g.id, wisdom: sample, insights: sample });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["X-GroupWisdom-Signature"] = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  try {
    const r = await fetch(url, { method: "POST", headers, body });
    res.json({ sent: true, status: r.status });
  } catch (err: any) {
    res.status(502).json({ sent: false, error: err.message });
  }
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
      // Where this came from, when the caller knows. Chat adapters send a channel
      // id so a per-channel question can be answered without reaching into another
      // channel's messages. Free-form and untrusted, so it is capped, never parsed.
      channel: typeof p.channel === "string" && p.channel.trim()
        ? p.channel.trim().slice(0, 100)
        : null,
    });
    created.push(item);
    queueIncrementalAnalysis(g.id, item, async (wisdom) => {
      notify(g.id, "update");
      if (wisdom?.length) await fireWebhook(g.id, wisdom);
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

// ── Wisdom ────────────────────────────────────────────────────────────────────
// What the engine produces is wisdom, and that is what the API calls it. The
// older /insights path is kept working, unchanged and undocumented, because
// people have it in running code; it is the same handler under a second name.

function readWisdom(req: any, res: any) {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: "Invalid or missing API key." });
  const g = resolveProject(req, a);
  if (!g) return res.status(404).json({ error: "Project not found." });
  const { limit, offset } = parsePagination(req.query);
  const kind = req.query.kind as string | undefined;
  const full = req.query.format === "full";
  const result = listInsightsPaginated(g.id, kind, limit, offset);
  const view = full ? wisdomFull : wisdomSimple;
  res.json({ ...result, data: result.data.map(view) });
}

apiv1.get("/projects/:id/wisdom", readWisdom);
apiv1.get("/projects/:id/insights", readWisdom);   // legacy name, still answered

// ── Wisdom feedback ───────────────────────────────────────────────────────────
// Verdicts on findings. Never rendered back into a channel: reactions are
// public in the relay, but what we conclude from them is ours.

/** Record a verdict. Authorised by a key that can reach the finding's project. */
apiv1.post("/wisdom/:id/feedback", (req, res) => {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: "Invalid or missing API key." });

  const found = getInsight(req.params.id);
  if (!found) return res.status(404).json({ error: "Wisdom not found." });

  // Reuse the project check by resolving against the finding's own project, so
  // one account can never leave feedback on another's wisdom.
  const g = resolveProject({ ...req, params: { id: found.group_id } }, a);
  if (!g) return res.status(404).json({ error: "Wisdom not found." });

  const verdict = String(req.body?.verdict ?? "").toLowerCase() as WisdomVerdict;
  if (!VERDICTS.includes(verdict)) {
    return res.status(400).json({ error: `verdict must be one of: ${VERDICTS.join(", ")}` });
  }
  const member = String(req.body?.member ?? "").slice(0, 128);
  const sourceEventId = req.body?.source_event_id ? String(req.body.source_event_id).slice(0, 128) : null;

  recordWisdomFeedback({ groupId: found.group_id, insightId: found.id, member, verdict, sourceEventId });
  res.status(201).json({ recorded: true, verdict });
});

/**
 * Withdraw a verdict, for when someone removes their reaction.
 *
 * Ownership is checked, not just authentication. Reaction event ids are public
 * in the relay, so without this anyone watching it could withdraw verdicts on
 * another account's wisdom.
 */
apiv1.delete("/wisdom/feedback/:sourceEventId", (req, res) => {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: "Invalid or missing API key." });

  const row = getFeedbackBySourceEvent(String(req.params.sourceEventId));
  if (!row) return res.json({ withdrawn: false });
  const g = resolveProject({ ...req, params: { id: row.group_id } }, a);
  if (!g) return res.status(404).json({ error: "Not found." });

  res.json({ withdrawn: withdrawWisdomFeedback(row.source_event_id!) });
});

/** A project's own verdicts and totals, for the account that owns it. */
apiv1.get("/projects/:id/feedback", (req, res) => {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: "Invalid or missing API key." });
  const g = resolveProject(req, a);
  if (!g) return res.status(404).json({ error: "Project not found." });
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "100"), 10) || 100, 1), 500);
  res.json({ summary: feedbackSummary(g.id), feedback: listWisdomFeedback(g.id, limit) });
});

/**
 * Every account's totals in one place, for whoever runs this service. Gated on
 * GW_ADMIN_EMAIL: unset, the route does not exist, so there is no ambient
 * privilege sitting in the code waiting to be reachable. Totals only, never
 * anyone's wisdom text.
 */
apiv1.get("/feedback/summary", (req, res) => {
  const admin = process.env.GW_ADMIN_EMAIL?.trim().toLowerCase();
  if (!admin) return res.status(404).json({ error: "Not found." });
  const a = auth(req);
  if (!a || a.kind !== "user" || a.user!.email.toLowerCase() !== admin) {
    return res.status(404).json({ error: "Not found." });   // same answer as unset, so it reveals nothing
  }
  res.json({ summary: feedbackSummary() });
});

// ── Engine transparency ───────────────────────────────────────────────────────
// Debug surfaces, not part of the public docs. Gate records answer "why did
// the engine speak / stay silent"; memory is what it currently believes the
// group knows.

apiv1.get("/projects/:id/gate-records", (req, res) => {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: "Invalid or missing API key." });
  const g = resolveProject(req, a);
  if (!g) return res.status(404).json({ error: "Project not found." });
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 200);
  res.json({ records: listGateRecords(g.id, limit) });
});

// Used by the Buzz adapter the moment it learns an agent's real name, so work
// already filed under a pubkey prefix stops appearing as a second person.
apiv1.post("/projects/:id/rename-contributor", (req, res) => {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: "Invalid or missing API key." });
  const g = resolveProject(req, a);
  if (!g) return res.status(404).json({ error: "Project not found." });
  const from = String(req.body?.from ?? "").trim();
  const to = String(req.body?.to ?? "").trim();
  if (!from || !to) return res.status(400).json({ error: "from and to are required." });
  if (to.length > 40) return res.status(400).json({ error: "to is too long." });
  res.json({ renamed: true, ...renameContributor(g.id, from, to) });
});

apiv1.get("/projects/:id/memory", (req, res) => {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: "Invalid or missing API key." });
  const g = resolveProject(req, a);
  if (!g) return res.status(404).json({ error: "Project not found." });
  const row = getGroupMemoryRaw(g.id);
  if (!row) return res.json({ memory: null, updated_at: null });
  let memory: unknown = null;
  try { memory = JSON.parse(row.memory); } catch { /* surface as null rather than 500 */ }
  res.json({ memory, updated_at: row.updated_at });
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
