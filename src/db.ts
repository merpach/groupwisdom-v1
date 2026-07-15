import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes } from "node:crypto";

const DB_PATH = process.env.GW_DB || "groupwisdom.db";

export const db = new DatabaseSync(DB_PATH);
try { db.exec("PRAGMA journal_mode = WAL;"); } catch { /* WAL unsupported on some filesystems */ }

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  api_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  name TEXT NOT NULL,
  role TEXT DEFAULT '',
  email TEXT DEFAULT '',
  access_token TEXT UNIQUE,
  api_key TEXT,
  user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  member_id TEXT,
  type TEXT NOT NULL DEFAULT 'note', -- link | note | file | thought
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  url TEXT DEFAULT '',
  source TEXT DEFAULT 'web', -- web | mcp | api
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS insights (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  kind TEXT NOT NULL, -- connection | blind_spot | conflict | pattern | question | decision
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new', -- new | acknowledged | dismissed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  name TEXT NOT NULL,
  access TEXT NOT NULL DEFAULT 'read', -- read | read_write
  status TEXT NOT NULL DEFAULT 'available', -- available | connected
  last_activity TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS knowledge_docs (
  group_id TEXT PRIMARY KEY REFERENCES groups(id),
  markdown TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  email TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS project_summaries (
  group_id TEXT PRIMARY KEY REFERENCES groups(id),
  summary TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_context (
  user_id TEXT NOT NULL REFERENCES users(id),
  group_id TEXT NOT NULL REFERENCES groups(id),
  summary TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, group_id)
);
CREATE TABLE IF NOT EXISTS group_settings (
  group_id TEXT PRIMARY KEY REFERENCES groups(id),
  webhook_url TEXT DEFAULT NULL,
  webhook_secret TEXT DEFAULT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS project_api_keys (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES groups(id),
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT DEFAULT NULL
);
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  purpose TEXT NOT NULL DEFAULT 'analysis',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Migrate: add columns if they don't exist yet
try { db.exec("ALTER TABLE group_settings ADD COLUMN webhook_secret TEXT DEFAULT NULL"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE group_settings ADD COLUMN engine TEXT NOT NULL DEFAULT 'claude'"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE insights ADD COLUMN confidence TEXT DEFAULT NULL"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE insights ADD COLUMN caveat TEXT DEFAULT NULL"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE insights ADD COLUMN do_next TEXT DEFAULT NULL"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE insights ADD COLUMN missing_voice TEXT DEFAULT NULL"); } catch { /* already exists */ }

export type User = { id: string; email: string; password_hash: string; name: string; api_key: string; created_at: string };
export type Group = { id: string; name: string; api_key: string; created_at: string };
export type Member = { id: string; group_id: string; name: string; role: string; email: string; access_token: string; api_key: string; user_id: string | null };
export type Item = {
  id: string; group_id: string; member_id: string | null; type: string;
  title: string; content: string; url: string; source: string; created_at: string;
};
export type Insight = {
  id: string; group_id: string; kind: string; title: string; body: string;
  status: string; created_at: string;
  confidence: string | null; caveat: string | null; do_next: string | null; missing_voice: string | null;
};
export type Connector = {
  id: string; group_id: string; name: string; access: string; status: string;
  last_activity: string | null;
};

const DEFAULT_CONNECTORS: Array<[string, string]> = [
  ["Claude", "read_write"],
  ["Cursor", "read"],
  ["ChatGPT", "read_write"],
  ["Perplexity", "read"],
];

export function createUser(email: string, passwordHash: string, name: string): User {
  const id = randomUUID();
  const api_key = "gw_" + randomBytes(18).toString("hex");
  db.prepare("INSERT INTO users (id, email, password_hash, name, api_key) VALUES (?, ?, ?, ?, ?)").run(id, email.toLowerCase().trim(), passwordHash, name, api_key);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User;
}
export const getUserByEmail = (email: string) =>
  db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase().trim()) as User | undefined;
export const getUserById = (id: string) =>
  db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined;
export const getUserByApiKey = (key: string) =>
  db.prepare("SELECT * FROM users WHERE api_key = ?").get(key) as User | undefined;
export const getGroupsForUser = (userId: string) =>
  db.prepare("SELECT g.* FROM groups g INNER JOIN members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY g.created_at").all(userId) as Group[];

export function createGroup(name: string): Group {
  const id = randomUUID();
  const apiKey = "gw_" + randomBytes(18).toString("hex");
  db.prepare("INSERT INTO groups (id, name, api_key) VALUES (?, ?, ?)").run(id, name, apiKey);
  db.prepare("INSERT INTO knowledge_docs (group_id, markdown) VALUES (?, ?)").run(
    id, `# ${name}\n\n_Nothing shared yet. Add the first link, note, or thought._\n`);
  for (const [cname, access] of DEFAULT_CONNECTORS) {
    db.prepare("INSERT INTO connectors (id, group_id, name, access) VALUES (?, ?, ?, ?)")
      .run(randomUUID(), id, cname, access);
  }
  return getGroup(id)!;
}

export function deleteGroup(id: string) {
  db.prepare("DELETE FROM insights WHERE group_id = ?").run(id);
  db.prepare("DELETE FROM items WHERE group_id = ?").run(id);
  db.prepare("DELETE FROM members WHERE group_id = ?").run(id);
  db.prepare("DELETE FROM connectors WHERE group_id = ?").run(id);
  db.prepare("DELETE FROM knowledge_docs WHERE group_id = ?").run(id);
  db.prepare("DELETE FROM groups WHERE id = ?").run(id);
}

export const getGroup = (id: string) =>
  db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as Group | undefined;
export const getGroupByKey = (key: string) =>
  db.prepare("SELECT * FROM groups WHERE api_key = ?").get(key) as Group | undefined;
export const listGroups = () =>
  db.prepare("SELECT * FROM groups ORDER BY created_at").all() as Group[];

export function addMember(groupId: string, name: string, role = "", email = "", userId?: string): Member {
  const id = randomUUID();
  const access_token = randomBytes(24).toString("hex");
  db.prepare("INSERT INTO members (id, group_id, name, role, email, access_token, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, groupId, name, role, email, access_token, userId ?? null);
  return db.prepare("SELECT * FROM members WHERE id = ?").get(id) as Member;
}
export const listMembers = (groupId: string) =>
  db.prepare("SELECT * FROM members WHERE group_id = ? ORDER BY created_at").all(groupId) as Member[];
export const getMemberByUserId = (groupId: string, userId: string) =>
  db.prepare("SELECT * FROM members WHERE group_id = ? AND user_id = ?").get(groupId, userId) as Member | undefined;
export const listItemsByMember = (groupId: string, memberId: string) =>
  db.prepare("SELECT * FROM items WHERE group_id = ? AND member_id = ? ORDER BY created_at DESC").all(groupId, memberId) as Item[];
export const getMemberByToken = (token: string) =>
  db.prepare("SELECT * FROM members WHERE access_token = ?").get(token) as Member | undefined;
export const getGroupsForMember = (memberId: string) =>
  db.prepare("SELECT g.* FROM groups g INNER JOIN members m ON m.group_id = g.id WHERE m.id = ? ORDER BY g.created_at").all(memberId) as Group[];
export const getGroupsByToken = (token: string) =>
  db.prepare("SELECT g.* FROM groups g INNER JOIN members m ON m.group_id = g.id WHERE m.access_token = ? ORDER BY g.created_at").all(token) as Group[];

export function addItem(groupId: string, data: Partial<Item>): Item {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO items (id, group_id, member_id, type, title, content, url, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, groupId, data.member_id ?? null, data.type ?? "note",
    data.title ?? "Untitled", data.content ?? "", data.url ?? "", data.source ?? "web");
  return db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Item;
}
export const listItems = (groupId: string) =>
  db.prepare("SELECT * FROM items WHERE group_id = ? ORDER BY created_at DESC").all(groupId) as Item[];

export type ItemWithMember = Item & { member_name: string | null };
export const listItemsWithMembers = (groupId: string): ItemWithMember[] =>
  db.prepare(
    "SELECT i.*, m.name as member_name FROM items i LEFT JOIN members m ON m.id = i.member_id WHERE i.group_id = ? ORDER BY i.created_at DESC"
  ).all(groupId) as ItemWithMember[];

export const searchItems = (groupId: string, q: string) =>
  db.prepare(
    "SELECT * FROM items WHERE group_id = ? AND (title LIKE ? OR content LIKE ? OR url LIKE ?) ORDER BY created_at DESC"
  ).all(groupId, `%${q}%`, `%${q}%`, `%${q}%`) as Item[];

export function addInsight(
  groupId: string, kind: string, title: string, body: string,
  meta?: { confidence?: string; caveat?: string; do_next?: string; missing_voice?: string },
): Insight {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO insights (id, group_id, kind, title, body, confidence, caveat, do_next, missing_voice) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, groupId, kind, title, body,
    meta?.confidence ?? null, meta?.caveat ?? null, meta?.do_next ?? null, meta?.missing_voice ?? null);
  return db.prepare("SELECT * FROM insights WHERE id = ?").get(id) as Insight;
}
export const listInsights = (groupId: string, kind?: string) =>
  kind
    ? db.prepare("SELECT * FROM insights WHERE group_id = ? AND kind = ? AND status != 'dismissed' ORDER BY created_at DESC").all(groupId, kind) as Insight[]
    : db.prepare("SELECT * FROM insights WHERE group_id = ? AND status != 'dismissed' ORDER BY created_at DESC").all(groupId) as Insight[];
export const setInsightStatus = (id: string, status: string) =>
  db.prepare("UPDATE insights SET status = ? WHERE id = ?").run(status, id);

export const listConnectors = (groupId: string) =>
  db.prepare("SELECT * FROM connectors WHERE group_id = ? ORDER BY created_at").all(groupId) as Connector[];
export const setConnectorStatus = (id: string, status: string) =>
  db.prepare("UPDATE connectors SET status = ?, last_activity = datetime('now') WHERE id = ?").run(status, id);
export const touchConnector = (groupId: string, name: string) =>
  db.prepare("UPDATE connectors SET last_activity = datetime('now'), status = 'connected' WHERE group_id = ? AND name = ?").run(groupId, name);

export const getKnowledgeDoc = (groupId: string) =>
  (db.prepare("SELECT markdown, updated_at FROM knowledge_docs WHERE group_id = ?").get(groupId) as
    { markdown: string; updated_at: string } | undefined) ?? { markdown: "", updated_at: "" };
export const setKnowledgeDoc = (groupId: string, markdown: string) =>
  db.prepare(
    "INSERT INTO knowledge_docs (group_id, markdown, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(group_id) DO UPDATE SET markdown = excluded.markdown, updated_at = datetime('now')"
  ).run(groupId, markdown);

export const getProjectSummary = (groupId: string): string =>
  ((db.prepare("SELECT summary FROM project_summaries WHERE group_id = ?").get(groupId) as { summary: string } | undefined)?.summary ?? "");

export const setProjectSummary = (groupId: string, summary: string) =>
  db.prepare(
    "INSERT INTO project_summaries (group_id, summary, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(group_id) DO UPDATE SET summary = excluded.summary, updated_at = datetime('now')"
  ).run(groupId, summary);

export type UserContext = { user_id: string; group_id: string; summary: string; updated_at: string; name: string };

export const setUserContext = (userId: string, groupId: string, summary: string) =>
  db.prepare(
    "INSERT INTO user_context (user_id, group_id, summary, updated_at) VALUES (?, ?, ?, datetime('now')) " +
    "ON CONFLICT(user_id, group_id) DO UPDATE SET summary = excluded.summary, updated_at = datetime('now')"
  ).run(userId, groupId, summary);

export const listUserContexts = (groupId: string): UserContext[] =>
  db.prepare(
    "SELECT uc.user_id, uc.group_id, uc.summary, uc.updated_at, u.name " +
    "FROM user_context uc JOIN users u ON u.id = uc.user_id " +
    "WHERE uc.group_id = ? ORDER BY uc.updated_at DESC"
  ).all(groupId) as UserContext[];

export type Invite = { id: string; group_id: string; email: string; token: string; status: string; created_at: string };

export function createInvite(groupId: string, email: string): Invite {
  const id = randomUUID();
  const token = randomBytes(20).toString("hex");
  db.prepare("INSERT INTO invites (id, group_id, email, token) VALUES (?, ?, ?, ?)").run(id, groupId, email, token);
  return db.prepare("SELECT * FROM invites WHERE id = ?").get(id) as Invite;
}
export const getInviteByToken = (token: string) =>
  db.prepare("SELECT * FROM invites WHERE token = ?").get(token) as Invite | undefined;
export const acceptInvite = (token: string) =>
  db.prepare("UPDATE invites SET status = 'accepted' WHERE token = ?").run(token);

export const getGroupEngine = (groupId: string): string =>
  ((db.prepare("SELECT engine FROM group_settings WHERE group_id = ?").get(groupId) as { engine: string } | undefined)?.engine ?? "claude");

export const setGroupEngine = (groupId: string, engine: string) => {
  db.prepare(
    "INSERT INTO group_settings (group_id, engine, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(group_id) DO UPDATE SET engine = excluded.engine, updated_at = datetime('now')"
  ).run(groupId, engine);
};

export const getGroupWebhook = (groupId: string): string | null =>
  ((db.prepare("SELECT webhook_url FROM group_settings WHERE group_id = ?").get(groupId) as { webhook_url: string | null } | undefined)?.webhook_url ?? null);

export const getGroupWebhookSecret = (groupId: string): string | null =>
  ((db.prepare("SELECT webhook_secret FROM group_settings WHERE group_id = ?").get(groupId) as { webhook_secret: string | null } | undefined)?.webhook_secret ?? null);

export const setGroupWebhook = (groupId: string, webhookUrl: string | null) => {
  const secret = webhookUrl
    ? (getGroupWebhookSecret(groupId) ?? randomBytes(24).toString("hex"))
    : null;
  db.prepare(
    "INSERT INTO group_settings (group_id, webhook_url, webhook_secret, updated_at) VALUES (?, ?, ?, datetime('now')) " +
    "ON CONFLICT(group_id) DO UPDATE SET webhook_url = excluded.webhook_url, webhook_secret = excluded.webhook_secret, updated_at = datetime('now')"
  ).run(groupId, webhookUrl, secret);
  return secret;
};

export const deleteItem = (itemId: string) =>
  db.prepare("DELETE FROM items WHERE id = ?").run(itemId);

export type PaginatedResult<T> = { data: T[]; total: number; limit: number; offset: number; has_more: boolean };

export function listItemsPaginated(groupId: string, limit = 50, offset = 0): PaginatedResult<Item> {
  const data = db.prepare("SELECT * FROM items WHERE group_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?").all(groupId, limit, offset) as Item[];
  const total = (db.prepare("SELECT COUNT(*) as n FROM items WHERE group_id = ?").get(groupId) as { n: number }).n;
  return { data, total, limit, offset, has_more: offset + data.length < total };
}

export function listInsightsPaginated(groupId: string, kind?: string, limit = 50, offset = 0): PaginatedResult<Insight> {
  const data = kind
    ? db.prepare("SELECT * FROM insights WHERE group_id = ? AND kind = ? AND status != 'dismissed' ORDER BY created_at DESC LIMIT ? OFFSET ?").all(groupId, kind, limit, offset) as Insight[]
    : db.prepare("SELECT * FROM insights WHERE group_id = ? AND status != 'dismissed' ORDER BY created_at DESC LIMIT ? OFFSET ?").all(groupId, limit, offset) as Insight[];
  const total = kind
    ? (db.prepare("SELECT COUNT(*) as n FROM insights WHERE group_id = ? AND kind = ? AND status != 'dismissed'").get(groupId, kind) as { n: number }).n
    : (db.prepare("SELECT COUNT(*) as n FROM insights WHERE group_id = ? AND status != 'dismissed'").get(groupId) as { n: number }).n;
  return { data, total, limit, offset, has_more: offset + data.length < total };
}

export type ProjectApiKey = { id: string; project_id: string; name: string; key: string; created_at: string; last_used_at: string | null };

export function createProjectApiKey(projectId: string, name: string): ProjectApiKey {
  const id = randomUUID();
  const key = "gw_proj_" + randomBytes(20).toString("hex");
  db.prepare("INSERT INTO project_api_keys (id, project_id, name, key) VALUES (?, ?, ?, ?)").run(id, projectId, name, key);
  return db.prepare("SELECT * FROM project_api_keys WHERE id = ?").get(id) as ProjectApiKey;
}

export const listProjectApiKeys = (projectId: string): ProjectApiKey[] =>
  db.prepare("SELECT * FROM project_api_keys WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as ProjectApiKey[];

export const getByProjectApiKey = (key: string): ProjectApiKey | undefined => {
  const row = db.prepare("SELECT * FROM project_api_keys WHERE key = ?").get(key) as ProjectApiKey | undefined;
  if (row) db.prepare("UPDATE project_api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  return row;
};

export const revokeProjectApiKey = (keyId: string) =>
  db.prepare("DELETE FROM project_api_keys WHERE id = ?").run(keyId);

// ── Usage tracking ─────────────────────────────────────────────────────────────

const COST_PER_TOKEN: Record<string, { input: number; output: number }> = {
  haiku:  { input: 1e-6,  output: 5e-6  },  // $1.00 / $5.00 per MTok
  sonnet: { input: 3e-6,  output: 15e-6 },  // $3.00 / $15.00 per MTok
};

const USER_BUDGET_USD = 50;

function modelRates(model: string) {
  if (model.includes("haiku")) return COST_PER_TOKEN.haiku;
  return COST_PER_TOKEN.sonnet;
}

export function recordUsage(
  groupId: string, model: string, inputTokens: number, outputTokens: number, purpose = "analysis"
): void {
  const rates = modelRates(model);
  const cost = inputTokens * rates.input + outputTokens * rates.output;
  db.prepare(
    "INSERT INTO usage_events (id, group_id, model, input_tokens, output_tokens, cost_usd, purpose) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(randomUUID(), groupId, model, inputTokens, outputTokens, cost, purpose);
}

export function getUserTotalCostUsd(userId: string): number {
  const row = db.prepare(
    "SELECT COALESCE(SUM(u.cost_usd), 0) as total FROM usage_events u " +
    "WHERE u.group_id IN (SELECT group_id FROM members WHERE user_id = ?)"
  ).get(userId) as { total: number };
  return row.total;
}

export function getUserUsagePct(userId: string): number {
  const cost = getUserTotalCostUsd(userId);
  return Math.min(Math.round((cost / USER_BUDGET_USD) * 100), 100);
}

export function getGroupOwnerUserId(groupId: string): string | null {
  const row = db.prepare(
    "SELECT user_id FROM members WHERE group_id = ? AND user_id IS NOT NULL ORDER BY created_at LIMIT 1"
  ).get(groupId) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}

export function isGroupOverBudget(groupId: string): boolean {
  const ownerId = getGroupOwnerUserId(groupId);
  if (!ownerId) return false;
  return getUserTotalCostUsd(ownerId) >= USER_BUDGET_USD;
}
