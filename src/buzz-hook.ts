/**
 * Hosted Buzz integration — mounted at /buzz.
 *
 * This is the webhook-driven path, which needs no persistent connection and no
 * process on anyone's laptop. Buzz pushes each message to us; we push wisdom back.
 *
 *   Buzz channel ──(workflow: message_posted → call_webhook)──▶ POST /buzz/ingest
 *                                                                     │
 *                                            GroupWisdom two-pass engine
 *                                                                     │
 *   Buzz channel ◀──(workflow: webhook → send_message)──── POST {relay}/hooks/{id}
 *
 * Install is per channel and must be done by a channel owner/admin: the relay's
 * SEC-006 rule requires elevated authority to save a workflow containing
 * `call_webhook`, since such a workflow forwards channel content outward. That
 * is deliberate — the person authorising data to leave the channel is the person
 * with the authority to do so — so GroupWisdom cannot self-install it.
 *
 * Endpoints:
 *   POST /buzz/ingest              — the webhook Buzz calls on every message
 *   POST /buzz/workspaces          — register a channel, returns the install YAML
 *   GET  /buzz/workspaces          — list your registered channels
 *   PATCH /buzz/workspaces/:id     — set the return hook once the admin creates it
 *   DELETE /buzz/workspaces/:id    — unregister
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
  createBuzzWorkspace,
  getBuzzWorkspaceByToken,
  getBuzzWorkspaceByChannel,
  listBuzzWorkspacesForProjects,
  setBuzzWorkspaceReturnHook,
  touchBuzzWorkspace,
  deleteBuzzWorkspace,
  type Insight,
  type BuzzWorkspace,
} from "./db.js";
import { queueIncrementalAnalysis } from "./engine.js";

export const buzzHook = Router();

const MAX_CONTENT = 4000;

// ── Auth (personal API key, same convention as /v1) ──────────────────────────

function authUser(req: any) {
  const key = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  return key ? getUserByApiKey(key) : undefined;
}

// ── Wisdom → back into the Buzz channel ──────────────────────────────────────

async function postWisdomBack(ws: BuzzWorkspace, wisdom: Insight[]) {
  if (!ws.return_hook_url || !wisdom.length) return;
  for (const w of wisdom) {
    const body = JSON.stringify({
      // These become {{trigger.wisdom}} / {{trigger.kind}} in the return workflow.
      wisdom: `${w.title}\n\n${w.body}`,
      kind: w.kind,
      channel: ws.channel_id,
    });
    try {
      const res = await fetch(ws.return_hook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!res.ok) console.warn(`[buzz-hook] return hook ${res.status} for channel ${ws.channel_id}`);
    } catch (err: any) {
      console.warn(`[buzz-hook] return hook failed: ${err.message}`);
    }
  }
}

// ── The webhook Buzz calls on every message ──────────────────────────────────

buzzHook.post("/ingest", (req, res) => {
  const token = (req.headers["x-buzz-token"] as string) || (req.query.token as string) || req.body?.token;
  if (!token) return res.status(401).json({ error: "Missing ingest token." });

  const ws = getBuzzWorkspaceByToken(String(token));
  if (!ws) return res.status(401).json({ error: "Unknown ingest token." });

  const { text, author, message_id } = req.body ?? {};
  const content = String(text ?? "").slice(0, MAX_CONTENT);
  if (!content.trim()) return res.status(202).json({ skipped: "empty message" });

  // Never re-ingest our own wisdom — the return workflow posts it as a normal
  // message, which would otherwise trigger this webhook again in a loop.
  if (req.body?.gw === "1" || /^\s*\[(convergence|opportunity|tension|pattern|direction|decision)\]/i.test(content)) {
    return res.status(202).json({ skipped: "own wisdom" });
  }

  const project = getGroup(ws.project_id);
  if (!project) return res.status(410).json({ error: "Project for this workspace no longer exists." });

  const contributor = String(author ?? "").slice(0, 24) || "buzz";
  const members = listMembers(ws.project_id);
  const member = members.find(m => m.name === contributor) ?? addMember(ws.project_id, contributor, "buzz");

  const item = addItem(ws.project_id, {
    member_id: member.id,
    type: "note",
    title: content.slice(0, 60),
    content,
    source: "buzz",
  });
  touchBuzzWorkspace(ws.id);

  // Respond immediately; the engine runs async and wisdom returns via the hook.
  res.status(202).json({ accepted: true, item_id: item.id, message_id: message_id ?? null });

  queueIncrementalAnalysis(ws.project_id, item, async (wisdom: Insight[]) => {
    if (wisdom?.length) await postWisdomBack(ws, wisdom);
  });
});

// ── Registration ─────────────────────────────────────────────────────────────

function installYaml(baseUrl: string, ws: BuzzWorkspace) {
  const ingestUrl = `${baseUrl}/buzz/ingest`;
  return [
    "name: GroupWisdom",
    "trigger:",
    "  on: message_posted",
    "steps:",
    "  - id: to_groupwisdom",
    "    action: call_webhook",
    `    url: ${ingestUrl}`,
    "    method: POST",
    "    headers:",
    `      x-buzz-token: ${ws.ingest_token}`,
    `    body: '{\"text\":\"{{trigger.text}}\",\"author\":\"{{trigger.author}}\",\"message_id\":\"{{trigger.message_id}}\",\"channel\":\"{{trigger.channel_id}}\"}'`,
  ].join("\n");
}

const RETURN_YAML = [
  "name: GroupWisdom Wisdom",
  "trigger:",
  "  on: webhook",
  "steps:",
  "  - id: post_wisdom",
  "    action: send_message",
  "    text: '{{trigger.wisdom}}'",
].join("\n");

buzzHook.post("/workspaces", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "Invalid or missing API key." });

  const { channel_id, channel_name, relay_url, project_id, return_hook_url } = req.body ?? {};
  if (!channel_id) return res.status(400).json({ error: "channel_id is required." });

  const existing = getBuzzWorkspaceByChannel(String(channel_id));
  if (existing) return res.status(409).json({ error: "This channel is already registered.", workspace_id: existing.id });

  // Use the caller's project if given (and theirs), otherwise create one for the channel.
  let projectId: string;
  if (project_id) {
    const owned = getGroupsForUser(user.id).some(g => g.id === project_id);
    if (!owned) return res.status(404).json({ error: "Project not found." });
    projectId = String(project_id);
  } else {
    const g = createGroup(`Buzz: ${channel_name || String(channel_id).slice(0, 8)}`);
    addMember(g.id, user.name, "", user.email, user.id);
    projectId = g.id;
  }

  const ws = createBuzzWorkspace({
    channelId: String(channel_id),
    channelName: channel_name ? String(channel_name) : "",
    relayUrl: relay_url ? String(relay_url) : "",
    projectId,
    returnHookUrl: return_hook_url ? String(return_hook_url) : null,
  });

  const baseUrl = `${req.headers["x-forwarded-proto"] ?? req.protocol}://${req.headers.host}`;
  res.status(201).json({
    workspace_id: ws.id,
    project_id: ws.project_id,
    ingest_token: ws.ingest_token,
    install: {
      note:
        "A channel owner or admin must create these two workflows — the relay requires " +
        "elevated authority for workflows that call external webhooks.",
      step_1_ingest_workflow: installYaml(baseUrl, ws),
      step_2_return_workflow: RETURN_YAML,
      step_3:
        "Create workflow 2 in Buzz, copy its /hooks/{id} URL, then PATCH " +
        `/buzz/workspaces/${ws.id} with { "return_hook_url": "<that url>" } so wisdom can post back.`,
    },
  });
});

buzzHook.get("/workspaces", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "Invalid or missing API key." });
  const projectIds = getGroupsForUser(user.id).map(g => g.id);
  const rows = listBuzzWorkspacesForProjects(projectIds).map(w => ({
    id: w.id,
    channel_id: w.channel_id,
    channel_name: w.channel_name,
    project_id: w.project_id,
    return_hook_configured: Boolean(w.return_hook_url),
    created_at: w.created_at,
    last_seen_at: w.last_seen_at,
  }));
  res.json(rows);
});

function ownedWorkspace(req: any) {
  const user = authUser(req);
  if (!user) return { error: 401 as const };
  const projectIds = getGroupsForUser(user.id).map(g => g.id);
  const ws = listBuzzWorkspacesForProjects(projectIds).find(w => w.id === req.params.id);
  return ws ? { ws } : { error: 404 as const };
}

buzzHook.patch("/workspaces/:id", (req, res) => {
  const found = ownedWorkspace(req);
  if (found.error === 401) return res.status(401).json({ error: "Invalid or missing API key." });
  if (found.error === 404 || !found.ws) return res.status(404).json({ error: "Workspace not found." });
  if ("return_hook_url" in (req.body ?? {})) {
    setBuzzWorkspaceReturnHook(found.ws.id, req.body.return_hook_url || null);
  }
  res.json({ updated: true, id: found.ws.id });
});

buzzHook.delete("/workspaces/:id", (req, res) => {
  const found = ownedWorkspace(req);
  if (found.error === 401) return res.status(401).json({ error: "Invalid or missing API key." });
  if (found.error === 404 || !found.ws) return res.status(404).json({ error: "Workspace not found." });
  deleteBuzzWorkspace(found.ws.id);
  res.json({ deleted: true, id: found.ws.id });
});
