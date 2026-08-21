import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes } from "node:crypto";
import { encryptField, decryptField, encryptionEnabled, isEncrypted } from "./crypto.js";

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
CREATE TABLE IF NOT EXISTS buzz_workspaces (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,           -- Buzz channel UUID
  channel_name TEXT NOT NULL DEFAULT '',
  relay_url TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL REFERENCES groups(id),
  ingest_token TEXT NOT NULL UNIQUE,  -- secret proving a webhook really came from this channel's workflow
  return_hook_url TEXT DEFAULT NULL,  -- Buzz /hooks/{id} that posts wisdom back into the channel
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT DEFAULT NULL
);
CREATE TABLE IF NOT EXISTS buzz_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  relay_url TEXT NOT NULL,
  auth_tag TEXT DEFAULT NULL,         -- NIP-OA attestation authorising our agent key
  label TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_connected_at TEXT DEFAULT NULL,
  last_error TEXT DEFAULT NULL
);
CREATE TABLE IF NOT EXISTS buzz_cursors (
  connection_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS group_memory (
  group_id TEXT PRIMARY KEY REFERENCES groups(id),
  memory TEXT NOT NULL DEFAULT '{}',  -- structured JSON: purpose, facts, decisions, open_questions, active_wisdom
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS gate_records (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  stage TEXT NOT NULL,        -- scan | review
  verdict TEXT NOT NULL,      -- silent | spoken | suppressed | error
  kind TEXT DEFAULT NULL,
  title TEXT DEFAULT NULL,
  reason TEXT DEFAULT NULL,
  insight_id TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wisdom_feedback (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  insight_id TEXT NOT NULL,           -- the finding being judged
  member TEXT NOT NULL DEFAULT '',    -- who judged it; a Buzz pubkey, already public in the relay
  verdict TEXT NOT NULL,              -- helpful | wrong | late
  source_event_id TEXT DEFAULT NULL,  -- the reaction event, so un-reacting can withdraw it
  withdrawn INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (insight_id, member)          -- one live verdict per person per card; newest wins
);
-- ── Microsoft Teams ────────────────────────────────────────────────────────
-- Teams pushes each message over HTTP rather than holding a connection open, so
-- everything the Buzz adapter keeps in memory has to live here instead: a
-- redeploy between a message arriving and its finding being ready must not lose
-- the address to reply to.
-- A team that has installed the app but has not yet been bound to a project.
-- Nothing is read from such a team: the code is posted into the channel, and
-- someone with a GroupWisdom account claims it. That way the decision to let a
-- team's messages leave Teams is made by a person, in our product, on purpose.
CREATE TABLE IF NOT EXISTS teams_pending_installs (
  team_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT '',
  team_name TEXT NOT NULL DEFAULT '',
  service_url TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS teams_installs (
  team_id TEXT PRIMARY KEY,            -- the Teams team the app was installed into
  tenant_id TEXT NOT NULL DEFAULT '',
  team_name TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL REFERENCES groups(id),
  service_url TEXT NOT NULL DEFAULT '',
  installed_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT DEFAULT NULL
);
-- One row per channel we have heard from. The channel id doubles as the scope
-- key the engine already understands, so a finding built here can only be built
-- from what this channel can see.
CREATE TABLE IF NOT EXISTS teams_conversations (
  channel_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL,
  service_url TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT '',
  channel_name TEXT NOT NULL DEFAULT '',
  reply_to_id TEXT DEFAULT NULL,       -- newest inbound activity, so a card can thread under it
  muted_until INTEGER NOT NULL DEFAULT -1,  -- -1 open, 0 muted indefinitely, else ms when it lifts
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- What we have already said where. Teams gives no way to ask "did I post this?",
-- and a duplicate finding is the one failure this product cannot afford.
CREATE TABLE IF NOT EXISTS teams_posted (
  channel_id TEXT NOT NULL,
  wisdom_id TEXT NOT NULL,
  activity_id TEXT DEFAULT NULL,
  posted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel_id, wisdom_id)
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
// Buzz: which channels a connection watches (JSON array; NULL means every channel it can see)
try { db.exec("ALTER TABLE buzz_connections ADD COLUMN channels TEXT DEFAULT NULL"); } catch { /* already exists */ }
// Buzz: channels the agent has seen, so the setup page can offer them as choices
try { db.exec("ALTER TABLE buzz_connections ADD COLUMN discovered TEXT DEFAULT NULL"); } catch { /* already exists */ }
// Usage: attribute spend to the owning user at write time. Attributing through
// the members table meant deleting a project erased its spend from the user's
// cap — delete a project, get a fresh $50.
try { db.exec("ALTER TABLE usage_events ADD COLUMN user_id TEXT DEFAULT NULL"); } catch { /* already exists */ }
// Provenance: which chat channel a message arrived from. NULL means we do not
// know — either it came straight through the API, or it predates this column.
// Memory spans a whole community on purpose (combining work across channels is
// the point), so this is how a per-channel answer can be held to the channel
// that asked, instead of reciting facts drawn from a channel the asker is not in.
try { db.exec("ALTER TABLE items ADD COLUMN channel TEXT DEFAULT NULL"); } catch { /* already exists */ }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_items_group_channel ON items(group_id, channel)"); } catch { /* fine */ }
// The channel a finding was drawn for, so a later scan for a different channel
// is not shown its headline as "already said".
try { db.exec("ALTER TABLE insights ADD COLUMN channel TEXT DEFAULT NULL"); } catch { /* already exists */ }

export type User = { id: string; email: string; password_hash: string; name: string; api_key: string; created_at: string };
export type Group = { id: string; name: string; api_key: string; created_at: string };
export type Member = { id: string; group_id: string; name: string; role: string; email: string; access_token: string; api_key: string; user_id: string | null };
export type Item = {
  id: string; group_id: string; member_id: string | null; type: string;
  title: string; content: string; url: string; source: string; created_at: string;
  /** Chat channel this arrived from, or null when it came through the API. */
  channel: string | null;
};
export type Insight = {
  id: string; group_id: string; kind: string; title: string; body: string;
  status: string; created_at: string;
  confidence: string | null; caveat: string | null; do_next: string | null; missing_voice: string | null;
  /** Channel this was drawn for, or null when it spans the whole project. */
  channel: string | null;
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
/**
 * Issue a fresh personal API key, invalidating the old one immediately.
 *
 * The counterpart to showing someone their key: a key you can see but cannot
 * replace is a key you can never recover from leaking.
 */
export function rotateUserApiKey(userId: string): string {
  const api_key = "gw_" + randomBytes(18).toString("hex");
  db.prepare("UPDATE users SET api_key = ? WHERE id = ?").run(api_key, userId);
  return api_key;
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
    id, encryptField(`# ${name}\n\n_Nothing shared yet. Add the first link, note, or thought._\n`));
  for (const [cname, access] of DEFAULT_CONNECTORS) {
    db.prepare("INSERT INTO connectors (id, group_id, name, access) VALUES (?, ?, ?, ?)")
      .run(randomUUID(), id, cname, access);
  }
  return getGroup(id)!;
}

export function deleteGroup(id: string) {
  // Every table referencing groups(id) must be cleared first, or the final
  // DELETE fails a foreign-key constraint and the whole request 500s. This
  // previously missed summaries, settings, contexts, invites, keys and Buzz
  // workspaces, so any project that had been analysed could not be deleted.
  db.prepare("DELETE FROM insights WHERE group_id = ?").run(id);
  db.prepare("DELETE FROM items WHERE group_id = ?").run(id);
  db.prepare("DELETE FROM members WHERE group_id = ?").run(id);
  db.prepare("DELETE FROM connectors WHERE group_id = ?").run(id);
  db.prepare("DELETE FROM knowledge_docs WHERE group_id = ?").run(id);
  db.prepare("DELETE FROM project_summaries WHERE group_id = ?").run(id);
  db.prepare("DELETE FROM user_context WHERE group_id = ?").run(id);
  db.prepare("DELETE FROM group_settings WHERE group_id = ?").run(id);
  db.prepare("DELETE FROM invites WHERE group_id = ?").run(id);
  db.prepare("DELETE FROM project_api_keys WHERE project_id = ?").run(id);
  db.prepare("DELETE FROM buzz_workspaces WHERE project_id = ?").run(id);
  // Teams rows key off team/channel rather than project, so the install is found
  // first and its channels cleared through it. Missing these would fail the
  // foreign key and make an analysed project undeletable, which is the exact bug
  // this function already had once.
  for (const t of db.prepare("SELECT team_id FROM teams_installs WHERE project_id = ?").all(id) as Array<{ team_id: string }>) {
    for (const c of db.prepare("SELECT channel_id FROM teams_conversations WHERE team_id = ?").all(t.team_id) as Array<{ channel_id: string }>) {
      db.prepare("DELETE FROM teams_posted WHERE channel_id = ?").run(c.channel_id);
    }
    db.prepare("DELETE FROM teams_conversations WHERE team_id = ?").run(t.team_id);
  }
  db.prepare("DELETE FROM teams_installs WHERE project_id = ?").run(id);
  db.prepare("DELETE FROM teams_pending_installs WHERE team_id NOT IN (SELECT team_id FROM teams_installs)").run();
  db.prepare("DELETE FROM group_memory WHERE group_id = ?").run(id);
  db.prepare("DELETE FROM gate_records WHERE group_id = ?").run(id);
  db.prepare("DELETE FROM wisdom_feedback WHERE group_id = ?").run(id);
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
  (db.prepare("SELECT * FROM items WHERE group_id = ? AND member_id = ? ORDER BY created_at DESC").all(groupId, memberId) as Item[]).map(decryptItem);
export const getMemberByToken = (token: string) =>
  db.prepare("SELECT * FROM members WHERE access_token = ?").get(token) as Member | undefined;
export const getGroupsForMember = (memberId: string) =>
  db.prepare("SELECT g.* FROM groups g INNER JOIN members m ON m.group_id = g.id WHERE m.id = ? ORDER BY g.created_at").all(memberId) as Group[];
export const getGroupsByToken = (token: string) =>
  db.prepare("SELECT g.* FROM groups g INNER JOIN members m ON m.group_id = g.id WHERE m.access_token = ? ORDER BY g.created_at").all(token) as Group[];

// What a community said is encrypted before it reaches the database file and
// decrypted here, inside the data layer, so nothing above ever sees ciphertext.
function decryptItem<T extends Item>(i: T): T {
  return { ...i, title: decryptField(i.title), content: decryptField(i.content) };
}

export function addItem(groupId: string, data: Partial<Item>): Item {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO items (id, group_id, member_id, type, title, content, url, source, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, groupId, data.member_id ?? null, data.type ?? "note",
    encryptField(data.title ?? "Untitled"), encryptField(data.content ?? ""), data.url ?? "", data.source ?? "web",
    data.channel ?? null);
  return decryptItem(db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Item);
}
export const listItems = (groupId: string) =>
  (db.prepare("SELECT * FROM items WHERE group_id = ? ORDER BY created_at DESC").all(groupId) as Item[]).map(decryptItem);

export type ItemWithMember = Item & { member_name: string | null };
export const listItemsWithMembers = (groupId: string): ItemWithMember[] =>
  (db.prepare(
    "SELECT i.*, m.name as member_name FROM items i LEFT JOIN members m ON m.id = i.member_id WHERE i.group_id = ? ORDER BY i.created_at DESC"
  ).all(groupId) as ItemWithMember[]).map(decryptItem);

export const searchItems = (groupId: string, q: string) => {
  // LIKE cannot see through ciphertext, so with encryption on the match runs
  // over decrypted rows in memory. Groups are small; this stays cheap.
  if (!encryptionEnabled()) {
    return db.prepare(
      "SELECT * FROM items WHERE group_id = ? AND (title LIKE ? OR content LIKE ? OR url LIKE ?) ORDER BY created_at DESC"
    ).all(groupId, `%${q}%`, `%${q}%`, `%${q}%`) as Item[];
  }
  const needle = q.toLowerCase();
  return listItems(groupId).filter(i =>
    i.title.toLowerCase().includes(needle) ||
    i.content.toLowerCase().includes(needle) ||
    (i.url ?? "").toLowerCase().includes(needle));
};

export function addInsight(
  groupId: string, kind: string, title: string, body: string,
  meta?: { confidence?: string; caveat?: string; do_next?: string; missing_voice?: string; channel?: string | null },
): Insight {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO insights (id, group_id, kind, title, body, confidence, caveat, do_next, missing_voice, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, groupId, kind, title, body,
    meta?.confidence ?? null, meta?.caveat ?? null, meta?.do_next ?? null, meta?.missing_voice ?? null,
    meta?.channel ?? null);
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

export const getKnowledgeDoc = (groupId: string) => {
  const row = db.prepare("SELECT markdown, updated_at FROM knowledge_docs WHERE group_id = ?").get(groupId) as
    { markdown: string; updated_at: string } | undefined;
  return row ? { ...row, markdown: decryptField(row.markdown) } : { markdown: "", updated_at: "" };
};
export const setKnowledgeDoc = (groupId: string, markdown: string) =>
  db.prepare(
    "INSERT INTO knowledge_docs (group_id, markdown, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(group_id) DO UPDATE SET markdown = excluded.markdown, updated_at = datetime('now')"
  ).run(groupId, encryptField(markdown));

// ── Group memory ──────────────────────────────────────────────────────────────
// The engine's long-term working knowledge per project: a compact structured
// summary read on every scan in place of raw history. The engine owns the JSON
// shape (see GroupMemory in engine.ts); this layer just stores it.

export const getGroupMemoryRaw = (groupId: string) => {
  const row = db.prepare("SELECT memory, updated_at FROM group_memory WHERE group_id = ?").get(groupId) as
    { memory: string; updated_at: string } | undefined;
  return row ? { ...row, memory: decryptField(row.memory) } : undefined;
};
export const setGroupMemoryRaw = (groupId: string, memory: string) =>
  db.prepare(
    "INSERT INTO group_memory (group_id, memory, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(group_id) DO UPDATE SET memory = excluded.memory, updated_at = datetime('now')"
  ).run(groupId, encryptField(memory));

// ── Gate records ──────────────────────────────────────────────────────────────
// Why the engine spoke or stayed silent, one row per verdict. The silent rows
// are the point: they make a quiet engine debuggable without pasting test
// messages into a live channel.

export type GateRecord = {
  id: string; group_id: string; stage: string; verdict: string;
  kind: string | null; title: string | null; reason: string | null;
  insight_id: string | null; created_at: string;
};
export function addGateRecord(groupId: string, rec: {
  stage: "scan" | "review" | "memory"; verdict: "silent" | "spoken" | "suppressed" | "error" | "dropped";
  kind?: string; title?: string; reason?: string; insightId?: string;
}) {
  db.prepare(
    "INSERT INTO gate_records (id, group_id, stage, verdict, kind, title, reason, insight_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(randomUUID(), groupId, rec.stage, rec.verdict,
    rec.kind ?? null, rec.title ?? null, rec.reason ?? null, rec.insightId ?? null);
}
export const listGateRecords = (groupId: string, limit = 50) =>
  db.prepare("SELECT * FROM gate_records WHERE group_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(groupId, limit) as GateRecord[];

// ── Wisdom feedback ───────────────────────────────────────────────────────────
// Verdicts on findings, gathered from reactions in the channel. The reactions
// themselves are public events in the relay; what we derive from them lives
// only here and is never posted back into a channel. This is the first signal
// that tells us whether the engine is any good, as opposed to merely quiet.

export type WisdomVerdict = "helpful" | "wrong" | "late";
export const VERDICTS: WisdomVerdict[] = ["helpful", "wrong", "late"];

export type FeedbackRow = {
  id: string; group_id: string; insight_id: string; member: string;
  verdict: string; source_event_id: string | null; withdrawn: number; created_at: string;
};

export const getInsight = (id: string) =>
  db.prepare("SELECT * FROM insights WHERE id = ?").get(id) as Insight | undefined;

/**
 * Record one person's verdict on one finding. A second reaction from the same
 * member replaces the first rather than stacking, because someone changing
 * their mind is one opinion, not two.
 */
export function recordWisdomFeedback(a: {
  groupId: string; insightId: string; member: string; verdict: WisdomVerdict; sourceEventId?: string | null;
}): void {
  db.prepare(
    "INSERT INTO wisdom_feedback (id, group_id, insight_id, member, verdict, source_event_id, withdrawn, created_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now')) " +
    "ON CONFLICT(insight_id, member) DO UPDATE SET " +
    "verdict = excluded.verdict, source_event_id = excluded.source_event_id, withdrawn = 0, created_at = datetime('now')"
  ).run(randomUUID(), a.groupId, a.insightId, a.member, a.verdict, a.sourceEventId ?? null);
}

/** Which project a recorded verdict belongs to, so a withdrawal can be authorised. */
export const getFeedbackBySourceEvent = (sourceEventId: string) =>
  db.prepare("SELECT * FROM wisdom_feedback WHERE source_event_id = ?").get(sourceEventId) as FeedbackRow | undefined;

/** Un-reacting withdraws the verdict. Kept as a row so the change itself is visible. */
export function withdrawWisdomFeedback(sourceEventId: string): boolean {
  return Number(db.prepare(
    "UPDATE wisdom_feedback SET withdrawn = 1 WHERE source_event_id = ? AND withdrawn = 0"
  ).run(sourceEventId).changes) > 0;
}

/** One project's verdicts, newest first, with the finding they judged. */
export const listWisdomFeedback = (groupId: string, limit = 100) =>
  db.prepare(
    "SELECT f.*, i.kind, i.title FROM wisdom_feedback f LEFT JOIN insights i ON i.id = f.insight_id " +
    "WHERE f.group_id = ? ORDER BY f.created_at DESC, f.rowid DESC LIMIT ?"
  ).all(groupId, limit) as Array<FeedbackRow & { kind: string | null; title: string | null }>;

/**
 * The numbers that say whether the engine is working: how often it is called
 * helpful against wrong, broken out by the confidence it claimed. A finding
 * marked high-confidence and judged wrong is the alarm worth watching.
 */
export function feedbackSummary(groupId?: string) {
  const where = groupId ? "WHERE f.withdrawn = 0 AND f.group_id = ?" : "WHERE f.withdrawn = 0";
  const args = groupId ? [groupId] : [];
  const rows = db.prepare(
    "SELECT f.verdict, COALESCE(i.confidence, 'unknown') AS confidence, COUNT(*) AS n " +
    "FROM wisdom_feedback f LEFT JOIN insights i ON i.id = f.insight_id " +
    `${where} GROUP BY f.verdict, confidence`
  ).all(...args) as Array<{ verdict: string; confidence: string; n: number }>;

  const total = rows.reduce((s, r) => s + r.n, 0);
  const byVerdict: Record<string, number> = {};
  for (const r of rows) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + r.n;
  const highConfidenceWrong = rows
    .filter(r => r.verdict === "wrong" && r.confidence === "high")
    .reduce((s, r) => s + r.n, 0);
  return { total, byVerdict, highConfidenceWrong, breakdown: rows };
}

/**
 * Did this project speak within the last N minutes? Two good findings minutes
 * apart still stack into a wall of text in a chat client, which reads as an
 * agent that will not stop talking. The spoken gate records are the log, so no
 * extra state is needed.
 */
/**
 * Rename a contributor everywhere the engine can still see them.
 *
 * When an agent's real name is learned late, its earlier work is already filed
 * under a pubkey prefix, and new work arrives under the real name. Wisdom then
 * cites both in one sentence ("The Marketer proposes … the strategy from
 * 51d3b66e locks …"), which reads as two people who are one. Members and the
 * stored memory both have to move for that to stop.
 */
export function renameContributor(groupId: string, from: string, to: string): { members: number; memoryUpdated: boolean } {
  if (!from || !to || from === to) return { members: 0, memoryUpdated: false };

  const existing = db.prepare("SELECT id FROM members WHERE group_id = ? AND name = ?").get(groupId, to) as { id: string } | undefined;
  const old = db.prepare("SELECT id FROM members WHERE group_id = ? AND name = ?").get(groupId, from) as { id: string } | undefined;

  let members = 0;
  if (old && existing) {
    // Both names already exist as members: move the items across, drop the duplicate.
    db.prepare("UPDATE items SET member_id = ? WHERE member_id = ?").run(existing.id, old.id);
    db.prepare("DELETE FROM members WHERE id = ?").run(old.id);
    members = 1;
  } else if (old) {
    db.prepare("UPDATE members SET name = ? WHERE id = ?").run(to, old.id);
    members = 1;
  }

  // Memory is a JSON blob, so the old name lives inside fact text and `by` alike.
  const row = getGroupMemoryRaw(groupId);
  let memoryUpdated = false;
  if (row && row.memory.includes(from)) {
    setGroupMemoryRaw(groupId, row.memory.split(from).join(to));
    memoryUpdated = true;
  }
  return { members, memoryUpdated };
}

export function spokeRecently(groupId: string, minutes: number): boolean {
  const row = db.prepare(
    "SELECT COUNT(*) as n FROM gate_records WHERE group_id = ? AND verdict = 'spoken' AND created_at > datetime('now', ?)"
  ).get(groupId, `-${minutes} minutes`) as { n: number };
  return row.n > 0;
}

export const getProjectSummary = (groupId: string): string =>
  decryptField((db.prepare("SELECT summary FROM project_summaries WHERE group_id = ?").get(groupId) as { summary: string } | undefined)?.summary ?? "");

export const setProjectSummary = (groupId: string, summary: string) =>
  db.prepare(
    "INSERT INTO project_summaries (group_id, summary, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(group_id) DO UPDATE SET summary = excluded.summary, updated_at = datetime('now')"
  ).run(groupId, encryptField(summary));

export type UserContext = { user_id: string; group_id: string; summary: string; updated_at: string; name: string };

export const setUserContext = (userId: string, groupId: string, summary: string) =>
  db.prepare(
    "INSERT INTO user_context (user_id, group_id, summary, updated_at) VALUES (?, ?, ?, datetime('now')) " +
    "ON CONFLICT(user_id, group_id) DO UPDATE SET summary = excluded.summary, updated_at = datetime('now')"
  ).run(userId, groupId, encryptField(summary));

export const listUserContexts = (groupId: string): UserContext[] =>
  (db.prepare(
    "SELECT uc.user_id, uc.group_id, uc.summary, uc.updated_at, u.name " +
    "FROM user_context uc JOIN users u ON u.id = uc.user_id " +
    "WHERE uc.group_id = ? ORDER BY uc.updated_at DESC"
  ).all(groupId) as UserContext[]).map(c => ({ ...c, summary: decryptField(c.summary) }));

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
  const data = (db.prepare("SELECT * FROM items WHERE group_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?").all(groupId, limit, offset) as Item[]).map(decryptItem);
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
  // Stamp the owning user now: spend must survive project deletion, or the cap
  // resets every time a project is removed.
  const userId = getGroupOwnerUserId(groupId);
  db.prepare(
    "INSERT INTO usage_events (id, group_id, model, input_tokens, output_tokens, cost_usd, purpose, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(randomUUID(), groupId, model, inputTokens, outputTokens, cost, purpose, userId);
}

export function getUserTotalCostUsd(userId: string): number {
  // user_id is stamped at write time; the membership join remains only for rows
  // recorded before the column existed.
  const row = db.prepare(
    "SELECT COALESCE(SUM(u.cost_usd), 0) as total FROM usage_events u " +
    "WHERE u.user_id = ? OR (u.user_id IS NULL AND u.group_id IN (SELECT group_id FROM members WHERE user_id = ?))"
  ).get(userId, userId) as { total: number };
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

// The per-user cap bounds each account, but nothing bounded the operator's
// total Anthropic bill across accounts: twenty communities connecting is
// twenty separate $50 budgets. This is the kill switch for the sum. Set
// GW_GLOBAL_BUDGET_USD on the server to tune it without a deploy.
// ── Security housekeeping ─────────────────────────────────────────────────────

/**
 * One-time sweep on boot: encrypt every plaintext row that predates the key.
 * Idempotent — already-encrypted rows are skipped — so it is safe to run on
 * every start, and a deploy that adds GW_DATA_KEY converts the backlog once.
 */
export function encryptExistingData(): { items: number; blobs: number } {
  if (!encryptionEnabled()) return { items: 0, blobs: 0 };
  let items = 0, blobs = 0;

  for (const row of db.prepare("SELECT id, title, content FROM items").all() as Array<{ id: string; title: string; content: string }>) {
    if (isEncrypted(row.content) && isEncrypted(row.title)) continue;
    db.prepare("UPDATE items SET title = ?, content = ? WHERE id = ?")
      .run(encryptField(row.title), encryptField(row.content), row.id);
    items++;
  }
  const blobTables: Array<[string, string, string]> = [
    ["group_memory", "memory", "group_id"],
    ["knowledge_docs", "markdown", "group_id"],
    ["project_summaries", "summary", "group_id"],
  ];
  for (const [table, col, key] of blobTables) {
    for (const row of db.prepare(`SELECT ${key} as k, ${col} as v FROM ${table}`).all() as Array<{ k: string; v: string }>) {
      if (!row.v || isEncrypted(row.v)) continue;
      db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${key} = ?`).run(encryptField(row.v), row.k);
      blobs++;
    }
  }
  for (const row of db.prepare("SELECT user_id, group_id, summary FROM user_context").all() as Array<{ user_id: string; group_id: string; summary: string }>) {
    if (!row.summary || isEncrypted(row.summary)) continue;
    db.prepare("UPDATE user_context SET summary = ? WHERE user_id = ? AND group_id = ?")
      .run(encryptField(row.summary), row.user_id, row.group_id);
    blobs++;
  }
  return { items, blobs };
}

/**
 * Retention: raw Buzz messages are working data, not an archive. Once the
 * engine has folded a batch into memory, the raw text is only needed for the
 * short conversational tail, so anything older is deleted for good. Scoped to
 * Buzz projects — the adapter ingests through the public API, so its items are
 * identified by their project, and API customers' own data is never touched by
 * our policy.
 */
export function pruneOldBuzzItems(days: number): number {
  if (!days || days <= 0) return 0;
  return Number(db.prepare(
    "DELETE FROM items WHERE created_at < datetime('now', ?) AND " +
    "(source = 'buzz' OR group_id IN (SELECT id FROM groups WHERE name LIKE 'Buzz: %'))"
  ).run(`-${Math.floor(days)} days`).changes);
}

/** Gate records are diagnostics, not history — cap how long they accumulate. */
export function pruneOldGateRecords(days = 90): number {
  return Number(db.prepare(
    "DELETE FROM gate_records WHERE created_at < datetime('now', ?)"
  ).run(`-${Math.floor(days)} days`).changes);
}

export function isGlobalOverBudget(): boolean {
  const cap = Number(process.env.GW_GLOBAL_BUDGET_USD || 250);
  const row = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) as total FROM usage_events").get() as { total: number };
  return row.total >= cap;
}

// ── Buzz workspaces ──────────────────────────────────────────────────────────
// One row per Buzz channel that has installed the GroupWisdom workflow.
// The ingest_token is what the channel's workflow presents when POSTing
// messages to us, so a webhook can be attributed to exactly one channel.

export type BuzzWorkspace = {
  id: string; channel_id: string; channel_name: string; relay_url: string;
  project_id: string; ingest_token: string; return_hook_url: string | null;
  created_at: string; last_seen_at: string | null;
};

export function createBuzzWorkspace(opts: {
  channelId: string; channelName?: string; relayUrl?: string;
  projectId: string; returnHookUrl?: string | null;
}): BuzzWorkspace {
  const id = randomUUID();
  const token = "bzw_" + randomBytes(24).toString("hex");
  db.prepare(
    `INSERT INTO buzz_workspaces (id, channel_id, channel_name, relay_url, project_id, ingest_token, return_hook_url)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, opts.channelId, opts.channelName ?? "", opts.relayUrl ?? "", opts.projectId, token, opts.returnHookUrl ?? null);
  return db.prepare("SELECT * FROM buzz_workspaces WHERE id = ?").get(id) as BuzzWorkspace;
}

export const getBuzzWorkspaceByToken = (token: string): BuzzWorkspace | undefined =>
  db.prepare("SELECT * FROM buzz_workspaces WHERE ingest_token = ?").get(token) as BuzzWorkspace | undefined;

export const getBuzzWorkspaceByChannel = (channelId: string): BuzzWorkspace | undefined =>
  db.prepare("SELECT * FROM buzz_workspaces WHERE channel_id = ?").get(channelId) as BuzzWorkspace | undefined;

export const listBuzzWorkspacesForProjects = (projectIds: string[]): BuzzWorkspace[] => {
  if (!projectIds.length) return [];
  const marks = projectIds.map(() => "?").join(",");
  return db.prepare(
    `SELECT * FROM buzz_workspaces WHERE project_id IN (${marks}) ORDER BY created_at DESC`
  ).all(...projectIds) as BuzzWorkspace[];
};

export function setBuzzWorkspaceReturnHook(id: string, url: string | null) {
  db.prepare("UPDATE buzz_workspaces SET return_hook_url = ? WHERE id = ?").run(url, id);
}

export function touchBuzzWorkspace(id: string) {
  db.prepare("UPDATE buzz_workspaces SET last_seen_at = datetime('now') WHERE id = ?").run(id);
}

export function deleteBuzzWorkspace(id: string) {
  db.prepare("DELETE FROM buzz_workspaces WHERE id = ?").run(id);
}

// ── Buzz connections ─────────────────────────────────────────────────────────
// One row per connected Buzz community. The supervisor opens a relay connection
// for each enabled row on boot, so a community stays connected across restarts
// and deploys with nothing running on anyone's machine.

export type BuzzConnection = {
  id: string; user_id: string; relay_url: string; auth_tag: string | null;
  label: string; enabled: number; created_at: string;
  last_connected_at: string | null; last_error: string | null;
  /** JSON array of channel uuids to watch. NULL = every channel the agent can see. */
  channels: string | null;
  /** JSON array of {id,name} the agent has discovered, for the setup UI. */
  discovered: string | null;
};

export function createBuzzConnection(opts: {
  userId: string; relayUrl: string; authTag?: string | null; label?: string;
}): BuzzConnection {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO buzz_connections (id, user_id, relay_url, auth_tag, label) VALUES (?, ?, ?, ?, ?)"
  ).run(id, opts.userId, opts.relayUrl, opts.authTag ?? null, opts.label ?? "");
  return db.prepare("SELECT * FROM buzz_connections WHERE id = ?").get(id) as BuzzConnection;
}

export const listEnabledBuzzConnections = (): BuzzConnection[] =>
  db.prepare("SELECT * FROM buzz_connections WHERE enabled = 1 ORDER BY created_at").all() as BuzzConnection[];

export const listBuzzConnectionsForUser = (userId: string): BuzzConnection[] =>
  db.prepare("SELECT * FROM buzz_connections WHERE user_id = ? ORDER BY created_at DESC").all(userId) as BuzzConnection[];

export const getBuzzConnection = (id: string): BuzzConnection | undefined =>
  db.prepare("SELECT * FROM buzz_connections WHERE id = ?").get(id) as BuzzConnection | undefined;

export function markBuzzConnected(id: string) {
  db.prepare("UPDATE buzz_connections SET last_connected_at = datetime('now'), last_error = NULL WHERE id = ?").run(id);
}

export function markBuzzConnectionError(id: string, error: string) {
  db.prepare("UPDATE buzz_connections SET last_error = ? WHERE id = ?").run(error.slice(0, 500), id);
}

export function setBuzzConnectionEnabled(id: string, enabled: boolean) {
  db.prepare("UPDATE buzz_connections SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}

export function deleteBuzzConnection(id: string) {
  db.prepare("DELETE FROM buzz_connections WHERE id = ?").run(id);
}

// ── Buzz cursors ─────────────────────────────────────────────────────────────
// Which messages a connection has already processed. This lives in the database
// rather than on disk because hosted filesystems are ephemeral: on Railway every
// deploy wipes the container, and a cursor lost that way causes the same Buzz
// messages to be ingested — and billed — again on the next boot.

export const getBuzzCursor = (connectionId: string): string | null => {
  const row = db.prepare("SELECT state FROM buzz_cursors WHERE connection_id = ?")
    .get(connectionId) as { state: string } | undefined;
  return row?.state ?? null;
};

export function setBuzzCursor(connectionId: string, state: string) {
  db.prepare(
    `INSERT INTO buzz_cursors (connection_id, state, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(connection_id) DO UPDATE SET state = excluded.state, updated_at = datetime('now')`
  ).run(connectionId, state);
}

/** Limit a connection to specific channels. Pass null to watch everything. */
export function setBuzzConnectionChannels(id: string, channels: string[] | null) {
  db.prepare("UPDATE buzz_connections SET channels = ? WHERE id = ?")
    .run(channels && channels.length ? JSON.stringify(channels) : null, id);
}

/** Record what the agent can see, so the setup page can offer real choices. */
export function setBuzzConnectionDiscovered(id: string, channels: Array<{ id: string; name: string }>) {
  db.prepare("UPDATE buzz_connections SET discovered = ? WHERE id = ?").run(JSON.stringify(channels), id);
}


// ── Microsoft Teams ─────────────────────────────────────────────────────────

export type TeamsInstall = {
  team_id: string; tenant_id: string; team_name: string; project_id: string;
  service_url: string; installed_by: string; created_at: string; last_seen_at: string | null;
};

export type TeamsConversation = {
  channel_id: string; team_id: string; conversation_id: string; service_url: string;
  tenant_id: string; channel_name: string; reply_to_id: string | null;
  muted_until: number; updated_at: string;
};

export const getTeamsInstall = (teamId: string): TeamsInstall | undefined =>
  db.prepare("SELECT * FROM teams_installs WHERE team_id = ?").get(teamId) as TeamsInstall | undefined;

export const getTeamsInstallForProject = (projectId: string): TeamsInstall | undefined =>
  db.prepare("SELECT * FROM teams_installs WHERE project_id = ?").get(projectId) as TeamsInstall | undefined;

/**
 * Bind a Teams team to a project. Idempotent on team_id: a reinstall updates
 * what we know rather than creating a second row that would split the team's
 * history across two projects.
 */
export function upsertTeamsInstall(a: {
  teamId: string; projectId: string; tenantId?: string; teamName?: string;
  serviceUrl?: string; installedBy?: string;
}): TeamsInstall {
  db.prepare(
    `INSERT INTO teams_installs (team_id, tenant_id, team_name, project_id, service_url, installed_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(team_id) DO UPDATE SET
       tenant_id   = excluded.tenant_id,
       team_name   = excluded.team_name,
       service_url = excluded.service_url,
       last_seen_at = datetime('now')`
  ).run(a.teamId, a.tenantId ?? "", a.teamName ?? "", a.projectId, a.serviceUrl ?? "", a.installedBy ?? "");
  return getTeamsInstall(a.teamId)!;
}

export function deleteTeamsInstall(teamId: string) {
  for (const c of db.prepare("SELECT channel_id FROM teams_conversations WHERE team_id = ?").all(teamId) as Array<{ channel_id: string }>) {
    db.prepare("DELETE FROM teams_posted WHERE channel_id = ?").run(c.channel_id);
  }
  db.prepare("DELETE FROM teams_conversations WHERE team_id = ?").run(teamId);
  db.prepare("DELETE FROM teams_installs WHERE team_id = ?").run(teamId);
}

export const getTeamsConversation = (channelId: string): TeamsConversation | undefined =>
  db.prepare("SELECT * FROM teams_conversations WHERE channel_id = ?").get(channelId) as TeamsConversation | undefined;

/**
 * Remember where to reply. Called on every inbound message, so the reply address
 * is always the freshest one Teams gave us — `serviceUrl` is regional and
 * documented as a per-conversation value rather than a constant.
 *
 * `muted_until` is deliberately not written here: mute is set by a person and
 * must survive the ordinary traffic that follows it.
 */
export function rememberTeamsConversation(a: {
  channelId: string; teamId?: string; conversationId: string; serviceUrl: string;
  tenantId?: string; channelName?: string; replyToId?: string | null;
}): TeamsConversation {
  db.prepare(
    `INSERT INTO teams_conversations
       (channel_id, team_id, conversation_id, service_url, tenant_id, channel_name, reply_to_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET
       team_id         = excluded.team_id,
       conversation_id = excluded.conversation_id,
       service_url     = excluded.service_url,
       tenant_id       = excluded.tenant_id,
       channel_name    = CASE WHEN excluded.channel_name = '' THEN teams_conversations.channel_name
                              ELSE excluded.channel_name END,
       reply_to_id     = excluded.reply_to_id,
       updated_at      = datetime('now')`
  ).run(a.channelId, a.teamId ?? "", a.conversationId, a.serviceUrl,
        a.tenantId ?? "", a.channelName ?? "", a.replyToId ?? null);
  return getTeamsConversation(a.channelId)!;
}

export const listTeamsConversations = (teamId: string): TeamsConversation[] =>
  db.prepare("SELECT * FROM teams_conversations WHERE team_id = ? ORDER BY updated_at DESC")
    .all(teamId) as TeamsConversation[];

export function setTeamsMute(channelId: string, until: number) {
  db.prepare("UPDATE teams_conversations SET muted_until = ?, updated_at = datetime('now') WHERE channel_id = ?")
    .run(until, channelId);
}

/** Has this finding already been said in this channel? */
export const teamsAlreadyPosted = (channelId: string, wisdomId: string): boolean =>
  !!db.prepare("SELECT 1 FROM teams_posted WHERE channel_id = ? AND wisdom_id = ?").get(channelId, wisdomId);

/**
 * Claim a finding for a channel, returning false if it was already claimed.
 *
 * Written before the post rather than after, because two overlapping polls both
 * checking "have we posted this?" would both see no and both post. The insert is
 * the lock; a failed post clears it again.
 */
export function claimTeamsPost(channelId: string, wisdomId: string): boolean {
  try {
    db.prepare("INSERT INTO teams_posted (channel_id, wisdom_id) VALUES (?, ?)").run(channelId, wisdomId);
    return true;
  } catch { return false; }        // primary-key collision: someone else has it
}

export function releaseTeamsPost(channelId: string, wisdomId: string) {
  db.prepare("DELETE FROM teams_posted WHERE channel_id = ? AND wisdom_id = ?").run(channelId, wisdomId);
}

export function recordTeamsPost(channelId: string, wisdomId: string, activityId: string | null) {
  db.prepare("UPDATE teams_posted SET activity_id = ? WHERE channel_id = ? AND wisdom_id = ?")
    .run(activityId, channelId, wisdomId);
}


// ── Pairing a Teams team to a project ───────────────────────────────────────

/**
 * Unambiguous alphabet: no I, L, O, U, 0 or 1. The code is read off a screen and
 * typed by hand, and the pairs that get confused are the ones that cost support
 * time. U is dropped as well so no code can spell something unfortunate.
 */
const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const PAIRING_LENGTH = 6;                        // 30^6 ≈ 729 million
const PAIRING_TTL_HOURS = 24;

/** Rejection-sampled so every character is equally likely — modulo bias here would shrink the space. */
function newPairingCode(): string {
  let out = "";
  while (out.length < PAIRING_LENGTH) {
    for (const b of randomBytes(PAIRING_LENGTH * 2)) {
      if (b >= 256 - (256 % PAIRING_ALPHABET.length)) continue;   // would bias the low letters
      out += PAIRING_ALPHABET[b % PAIRING_ALPHABET.length];
      if (out.length === PAIRING_LENGTH) break;
    }
  }
  return out;
}

/** People type these back with spaces, dashes and lowercase. All of it is noise. */
export const normalisePairingCode = (raw: string): string =>
  String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export type TeamsPendingInstall = {
  team_id: string; tenant_id: string; team_name: string; service_url: string;
  conversation_id: string; code: string; created_at: string;
};

export const getPendingTeamsInstall = (teamId: string): TeamsPendingInstall | undefined =>
  db.prepare("SELECT * FROM teams_pending_installs WHERE team_id = ?").get(teamId) as TeamsPendingInstall | undefined;

/**
 * Start (or resume) pairing for a team.
 *
 * Idempotent while the code is still valid, so a reinstall — or Teams resending
 * an install event, which it does — shows the same code rather than quietly
 * invalidating the one already on screen. An expired code is replaced.
 */
export function startTeamsPairing(a: {
  teamId: string; tenantId?: string; teamName?: string; serviceUrl?: string; conversationId?: string;
}): TeamsPendingInstall {
  const existing = getPendingTeamsInstall(a.teamId);
  const fresh = existing && db.prepare(
    `SELECT 1 FROM teams_pending_installs WHERE team_id = ? AND created_at > datetime('now', ?)`
  ).get(a.teamId, `-${PAIRING_TTL_HOURS} hours`);

  if (existing && fresh) {
    db.prepare(
      `UPDATE teams_pending_installs SET tenant_id = ?, team_name = ?, service_url = ?, conversation_id = ?
       WHERE team_id = ?`
    ).run(a.tenantId ?? "", a.teamName ?? "", a.serviceUrl ?? "", a.conversationId ?? "", a.teamId);
    return getPendingTeamsInstall(a.teamId)!;
  }

  db.prepare("DELETE FROM teams_pending_installs WHERE team_id = ?").run(a.teamId);
  // A collision is astronomically unlikely but the column is UNIQUE, so an
  // unhandled one would surface as a 500 on somebody's install.
  for (let i = 0; i < 5; i++) {
    try {
      db.prepare(
        `INSERT INTO teams_pending_installs (team_id, tenant_id, team_name, service_url, conversation_id, code)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(a.teamId, a.tenantId ?? "", a.teamName ?? "", a.serviceUrl ?? "", a.conversationId ?? "", newPairingCode());
      return getPendingTeamsInstall(a.teamId)!;
    } catch { /* code already taken — draw another */ }
  }
  throw new Error("could not allocate a pairing code");
}

/** The pending install a code refers to, if the code is real and still fresh. */
export const getPendingTeamsInstallByCode = (raw: string): TeamsPendingInstall | undefined => {
  const code = normalisePairingCode(raw);
  if (code.length !== PAIRING_LENGTH) return undefined;
  return db.prepare(
    `SELECT * FROM teams_pending_installs WHERE code = ? AND created_at > datetime('now', ?)`
  ).get(code, `-${PAIRING_TTL_HOURS} hours`) as TeamsPendingInstall | undefined;
};

export function deletePendingTeamsInstall(teamId: string) {
  db.prepare("DELETE FROM teams_pending_installs WHERE team_id = ?").run(teamId);
}

/** Expired codes are not evidence of anything and should not sit around being guessable. */
export function pruneExpiredTeamsPairings(): number {
  const before = db.prepare("SELECT COUNT(*) AS n FROM teams_pending_installs").get() as { n: number };
  db.prepare(`DELETE FROM teams_pending_installs WHERE created_at <= datetime('now', ?)`)
    .run(`-${PAIRING_TTL_HOURS} hours`);
  const after = db.prepare("SELECT COUNT(*) AS n FROM teams_pending_installs").get() as { n: number };
  return before.n - after.n;
}

/**
 * Redeem a code: bind the team to a project and retire the code.
 *
 * The delete and the insert are one transaction because a half-done pairing is
 * the worst of both — a team bound to a project with a live code still on screen
 * for someone else to claim.
 */
export function claimTeamsPairing(rawCode: string, projectId: string): TeamsInstall | null {
  const pending = getPendingTeamsInstallByCode(rawCode);
  if (!pending) return null;
  if (getTeamsInstall(pending.team_id)) { deletePendingTeamsInstall(pending.team_id); return null; }

  db.exec("BEGIN IMMEDIATE");
  try {
    const install = upsertTeamsInstall({
      teamId: pending.team_id, projectId,
      tenantId: pending.tenant_id, teamName: pending.team_name, serviceUrl: pending.service_url,
    });
    deletePendingTeamsInstall(pending.team_id);
    db.exec("COMMIT");
    return install;
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
