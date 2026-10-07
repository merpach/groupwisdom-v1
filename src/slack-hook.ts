/**
 * Slack — mounted at /slack, ahead of the JSON body parser.
 *
 * Slack signs every request over its exact bytes, so the three endpoints it
 * calls read the raw body themselves and check the signature before parsing
 * anything. That is why this router is mounted before express.json() in
 * index.ts rather than beside the Teams one.
 *
 *   "Add to Slack" on /slack ──▶ GET /slack/install ──▶ Slack consent ──▶ GET /slack/oauth/callback
 *   /invite @GroupWisdom     ──▶ POST /slack/events (member_joined_channel) ──▶ the channel's project
 *   a message in that channel ─▶ POST /slack/events (message) ──▶ engine ──▶ chat.postMessage, in thread
 *   Helpful / Wrong / Late    ──▶ POST /slack/interactions ──▶ wisdom feedback
 *   /groupwisdom memory       ──▶ POST /slack/commands
 *
 * Three decisions shape the rest:
 *
 *   - It reads only channels someone invited it to. Slack delivers nothing
 *     else, so a workspace opts in channel by channel without anything to
 *     configure on our side.
 *   - Each channel is its own project: its own memory, quiet period and sense
 *     of what is new. A finding could never cross channels anyway, and a memory
 *     shared across a whole company is what made the Teams cards reach.
 *   - The person who installs it agrees, on our page, to what is stored and
 *     where it goes. Slack's terms require that authorisation from the
 *     installing organisation, and the channel is told the same on arrival.
 *
 * Endpoints:
 *   GET    /slack/install            — start an install (signed in, consent given)
 *   GET    /slack/oauth/callback     — Slack returns here with the code
 *   POST   /slack/events             — the Events API (Slack calls this)
 *   POST   /slack/interactions       — button presses (Slack calls this)
 *   POST   /slack/commands           — /groupwisdom (Slack calls this)
 *   GET    /slack/installs           — your workspaces and their channels
 *   DELETE /slack/installs/:teamId   — disconnect a workspace and delete what it gave us
 */
import express, { Router } from "express";
import {
  verifySlackSignature,
  shouldIngestSlack,
  slackTextToPlain,
  mentionedUserIds,
  slackMentionCommand,
  slackSlashCommand,
  slackItemTitle,
  slackFindingMessage,
  escapeSlack,
  FEEDBACK_ACTIONS,
  SLACK_WELCOME,
  SLACK_SHARED_REFUSAL,
  SLACK_HELP,
  type SlackMessageEvent,
} from "./adapters/slack.js";
import { postMessage, channelInfo, userName, oauthAccess, appsUninstall, respondTo } from "./adapters/slack-client.js";
import { muteUntil, isMutedAt, MUTE_FOREVER, DEMO_INTRO, DEMO_MESSAGES, DEMO_CARD, markFor } from "./adapters/buzz.js";
import { formatMemoryReply } from "./adapters/teams.js";
import {
  getUserById,
  getUserByApiKey,
  getGroup,
  listMembers,
  addMember,
  addItem,
  listItems,
  getInsight,
  recordWisdomFeedback,
  getSlackInstall,
  listSlackInstallsForUser,
  upsertSlackInstall,
  getSlackChannel,
  listSlackChannels,
  upsertSlackChannel,
  setSlackChannelActive,
  renameSlackChannel,
  setSlackMute,
  claimSlackPost,
  releaseSlackPost,
  recordSlackPost,
  firstSightOfSlackEvent,
  createSlackOAuthState,
  consumeSlackOAuthState,
  deleteSlackWorkspace,
  pruneOldSlackItems,
  type Insight,
  type SlackChannel,
  type SlackInstall,
} from "./db.js";
import { queueIncrementalAnalysis, loadGroupMemory } from "./engine.js";

export const slackHook = Router();

/** Everything the bot can do, and nothing it does not need. No private channels, no DMs, no files. */
export const SLACK_SCOPES = ["channels:history", "channels:read", "chat:write", "users:read", "commands"];

/**
 * The words the installer agrees to on /slack, by date. Stored with the
 * install, so a later change to the wording is a new version someone has to
 * agree to rather than a silent edit of what they already accepted.
 */
export const SLACK_CONSENT_VERSION = "2026-10-07";

const PUBLIC_BASE = process.env.GW_PUBLIC_URL || "https://testgroupwisdom.com";
const REDIRECT_URI = `${PUBLIC_BASE}/slack/oauth/callback`;
const MAX_CONTENT = 4000;
const DEMO_BEAT_MS = Number(process.env.GW_DEMO_BEAT_MS || 8000);
const demoRunning = new Set<string>();

const log = (m: string) => console.log("[slack]", m);

/** The project's channel key. Items carry it, so a finding stays where it was drawn. */
const channelKey = (channelId: string) => `slack:${channelId}`;

// ── Signed requests ─────────────────────────────────────────────────────────

const rawBody = express.raw({ type: () => true, limit: "1mb" });

/**
 * Nothing Slack sends is read until its signature checks out against our
 * signing secret. Without this, anyone who found the URL could post invented
 * messages attributed to real colleagues into a customer's project, billed to
 * that customer's allowance.
 */
function signed(req: any, res: any, next: any) {
  const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const verdict = verifySlackSignature(
    process.env.SLACK_SIGNING_SECRET,
    req.get("x-slack-request-timestamp"),
    req.get("x-slack-signature"),
    body,
  );
  if (!verdict.ok) {
    log(`rejected ${req.path}: ${verdict.reason}`);
    return res.status(401).json({ error: "Unauthorized." });
  }
  req.rawText = body.toString("utf8");
  next();
}

// ── The Events API ──────────────────────────────────────────────────────────

/**
 * Slack retries anything not acknowledged within three seconds, and a retry
 * would read the same message twice. So the event is marked as seen and
 * acknowledged at once, and the work happens after.
 */
slackHook.post("/events", rawBody, signed, (req: any, res) => {
  let payload: any;
  try { payload = JSON.parse(req.rawText); } catch { return res.status(400).json({ error: "Bad request." }); }

  // Sent once when the request URL is saved in Slack's app settings.
  if (payload?.type === "url_verification") return res.json({ challenge: String(payload.challenge ?? "") });
  if (payload?.type !== "event_callback") return res.status(200).end();

  const fresh = firstSightOfSlackEvent(String(payload.event_id ?? ""));
  res.status(200).end();
  if (!fresh) return;
  handleEvent(payload).catch(e => log(`handler failed: ${(e as Error).message}`));
});

async function handleEvent(payload: any) {
  const teamId = String(payload.team_id ?? payload.event?.team ?? "");
  const ev = payload.event ?? {};

  // Uninstalled, or our bot token revoked: everything this workspace gave us goes.
  if (ev.type === "app_uninstalled" || (ev.type === "tokens_revoked" && (ev.tokens?.bot ?? []).length)) {
    const n = deleteSlackWorkspace(teamId);
    log(`removed from workspace ${teamId}: deleted ${n} channel project(s)`);
    return;
  }

  const install = getSlackInstall(teamId);
  if (!install) return;

  switch (ev.type) {
    case "member_joined_channel":
      if (ev.user === install.bot_user_id) await onInvited(install, String(ev.channel ?? ""));
      return;
    case "member_left_channel":
      if (ev.user === install.bot_user_id) onRemoved(install, String(ev.channel ?? ""));
      return;
    case "channel_left":
      onRemoved(install, String(ev.channel ?? ""));
      return;
    case "channel_rename":
      if (ev.channel?.id) renameSlackChannel(teamId, String(ev.channel.id), String(ev.channel.name ?? ""));
      return;
    case "message":
      await onMessage(install, ev as SlackMessageEvent);
      return;
  }
}

/** Invited to a channel: make (or reopen) its project and say what happens now. */
async function onInvited(install: SlackInstall, channelId: string): Promise<SlackChannel | null> {
  if (!channelId) return null;
  let info = { name: "", shared: false, isPrivate: false };
  try { info = await channelInfo(install.bot_token, channelId); }
  catch (e) { log(`could not look up ${channelId}: ${(e as Error).message}`); }

  if (info.isPrivate) return null;                     // never asked for, so never read
  if (info.shared) {
    await say(install, channelId, SLACK_SHARED_REFUSAL);
    log(`refused shared channel ${channelId} in ${install.team_name}`);
    return null;
  }

  const { channel, created } = upsertSlackChannel({
    teamId: install.team_id, channelId, channelName: info.name,
    ownerUserId: install.installed_by, teamName: install.team_name,
  });
  await say(install, channelId, created ? SLACK_WELCOME : "Back. I'll pick up where I left off in this channel.");
  log(`${created ? "invited to" : "back in"} #${info.name || channelId} in ${install.team_name}`);
  return channel;
}

function onRemoved(install: SlackInstall, channelId: string) {
  if (!channelId || !getSlackChannel(install.team_id, channelId)) return;
  setSlackChannelActive(install.team_id, channelId, false);
  log(`removed from ${channelId} in ${install.team_name}; reading stopped`);
}

/**
 * The channel a message arrived in. Normally made when the bot was invited;
 * made here instead if that event never reached us, so a missed event costs a
 * welcome message arriving late rather than a channel that is silently unread.
 */
async function channelFor(install: SlackInstall, ev: SlackMessageEvent): Promise<SlackChannel | null> {
  const channelId = String(ev.channel ?? "");
  const existing = getSlackChannel(install.team_id, channelId);
  if (existing) return existing;
  if (ev.is_ext_shared_channel || ev.channel_type !== "channel") return null;
  return onInvited(install, channelId);
}

async function onMessage(install: SlackInstall, ev: SlackMessageEvent) {
  const text = String(ev.text ?? "");

  // A command addressed to the bot is answered, not read as work.
  const isPerson = !ev.subtype && !ev.bot_id && !!ev.user && ev.user !== install.bot_user_id;
  if (isPerson && ev.channel_type === "channel" && !ev.is_ext_shared_channel) {
    const cmd = slackMentionCommand(text, install.bot_user_id);
    if (cmd) {
      const ch = await channelFor(install, ev);
      if (!ch || !ch.active) return;
      const reply = commandReply(cmd, install, ch);
      await say(install, ch.channel_id, reply.text, ev.thread_ts || ev.ts);
      if (reply.after) await reply.after();
      return;
    }
  }

  if (!shouldIngestSlack(ev, install.bot_user_id)) return;
  const ch = await channelFor(install, ev);
  if (!ch || !ch.active) return;
  const project = getGroup(ch.project_id);
  if (!project) return;

  const names = new Map<string, string>();
  for (const id of mentionedUserIds(text)) names.set(id, await userName(install.bot_token, install.team_id, id));
  const content = slackTextToPlain(text, names).slice(0, MAX_CONTENT);
  if (!content.trim()) return;

  const contributor = (await userName(install.bot_token, install.team_id, String(ev.user))).slice(0, 64);
  const member = listMembers(project.id).find(m => m.name === contributor) ?? addMember(project.id, contributor, "slack");

  const item = addItem(project.id, {
    member_id: member.id,
    type: "note",
    title: slackItemTitle(content),
    content,
    source: "slack",
    channel: channelKey(ch.channel_id),
  });
  // Names and sizes only, the same line the other adapters write. Content never reaches the host log.
  log(`ingested → project ${project.id.slice(0, 8)} | #${ch.channel_name || ch.channel_id} | from ${contributor} (${content.length} chars)`);

  // A finding answers the message that completed it, in that message's thread.
  const anchor = ev.thread_ts || ev.ts;
  queueIncrementalAnalysis(project.id, item, async (wisdom: Insight[]) => {
    if (wisdom?.length) await postSlackFindings(install.team_id, ch.channel_id, wisdom, anchor);
  });
}

// ── Commands, by mention or by /groupwisdom ─────────────────────────────────

function mutedNow(ch: SlackChannel | undefined, now = Date.now()): boolean {
  if (!ch || ch.muted_until < 0) return false;
  return isMutedAt(ch.muted_until, now);
}

/**
 * What a command says back, and anything it does afterwards. The same answer
 * whether it was asked by mention or by slash command; only the delivery
 * differs. `public` is whether everyone in the channel should see it.
 */
function commandReply(
  cmd: { name: string; args: string },
  install: SlackInstall,
  ch: SlackChannel,
): { text: string; public: boolean; after?: () => Promise<void> } {
  const now = Date.now();

  if (cmd.name === "mute") {
    const until = muteUntil(cmd.args, now);
    setSlackMute(ch.team_id, ch.channel_id, until);
    log(`muted #${ch.channel_name || ch.channel_id}${until === MUTE_FOREVER ? "" : " until midnight UTC"}`);
    return {
      public: true,
      text: until === MUTE_FOREVER
        ? "Quiet from here. I'll keep reading, and `/groupwisdom unmute` brings me back."
        : "Quiet for the rest of the day (until midnight UTC). I'll keep reading meanwhile.",
    };
  }

  if (cmd.name === "unmute") {
    setSlackMute(ch.team_id, ch.channel_id, -1);
    return { public: true, text: "Back on." };
  }

  if (cmd.name === "memory") {
    const mem = loadGroupMemory(ch.project_id);
    if (!mem || !(mem.facts.length || mem.decisions.length || mem.open_questions.length)) {
      return { public: false, text: "I haven't built up anything here yet. Once people share work in this channel I'll have something to show." };
    }
    const text = formatMemoryReply(mem, listItems(ch.project_id), { scoped: false, hidden: 0, muted: mutedNow(ch, now) });
    return { public: false, text: escapeSlack(text) };
  }

  if (cmd.name === "demo") {
    const key = `${ch.team_id}:${ch.channel_id}`;
    if (demoRunning.has(key)) return { public: false, text: "A demo is already running here. Give it a moment." };
    return {
      public: false,
      text: "Starting a one-minute demo in this channel.",
      after: () => runDemo(install, ch),
    };
  }

  return { public: false, text: SLACK_HELP };
}

/**
 * The scripted example, posted by the bot. Its own messages are never read
 * back in, so none of it enters the channel's memory or costs anything.
 */
async function runDemo(install: SlackInstall, ch: SlackChannel) {
  const key = `${ch.team_id}:${ch.channel_id}`;
  if (demoRunning.has(key)) return;
  demoRunning.add(key);
  const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
  try {
    await say(install, ch.channel_id, DEMO_INTRO);
    for (const line of DEMO_MESSAGES) { await pause(DEMO_BEAT_MS); await say(install, ch.channel_id, `“${line}”`); }
    await pause(DEMO_BEAT_MS * 1.5);                   // the pause before the finding is the point
    await say(install, ch.channel_id, `${markFor(DEMO_CARD.kind)} *${DEMO_CARD.title}*\n${DEMO_CARD.body}`);
    log(`ran demo in #${ch.channel_name || ch.channel_id}`);
  } finally { demoRunning.delete(key); }
}

slackHook.post("/commands", rawBody, signed, (req: any, res) => {
  const p = new URLSearchParams(req.rawText);
  const install = getSlackInstall(p.get("team_id") ?? "");
  if (!install) {
    return res.json({ response_type: "ephemeral", text: `GroupWisdom isn't connected to this workspace any more. Reconnect it at ${PUBLIC_BASE}/slack.` });
  }
  const cmd = slackSlashCommand(p.get("text") ?? "");
  if (cmd.name === "help") return res.json({ response_type: "ephemeral", text: SLACK_HELP });

  const ch = getSlackChannel(install.team_id, p.get("channel_id") ?? "");
  if (!ch || !ch.active) {
    return res.json({ response_type: "ephemeral", text: "I'm not in this channel. Invite me with `/invite @GroupWisdom` and I'll start reading it." });
  }
  const reply = commandReply(cmd, install, ch);
  res.json({ response_type: reply.public ? "in_channel" : "ephemeral", text: reply.text });
  reply.after?.().catch(e => log(`command ${cmd.name} failed: ${(e as Error).message}`));
});

// ── Feedback buttons ────────────────────────────────────────────────────────

slackHook.post("/interactions", rawBody, signed, (req: any, res) => {
  let payload: any;
  try { payload = JSON.parse(new URLSearchParams(req.rawText).get("payload") ?? ""); }
  catch { return res.status(400).json({ error: "Bad request." }); }
  res.status(200).end();
  handleInteraction(payload).catch(e => log(`interaction failed: ${(e as Error).message}`));
});

async function handleInteraction(p: any) {
  if (p?.type !== "block_actions") return;
  const action = (p.actions ?? [])[0];
  const verdict = FEEDBACK_ACTIONS[String(action?.action_id ?? "")];
  if (!verdict) return;

  const teamId = String(p.team?.id ?? "");
  const channelId = String(p.channel?.id ?? p.container?.channel_id ?? "");
  const install = getSlackInstall(teamId);
  const ch = install ? getSlackChannel(teamId, channelId) : undefined;
  const finding = getInsight(String(action?.value ?? ""));
  // Recorded only against a finding that belongs to the channel it was pressed in.
  if (!install || !ch || !finding || finding.group_id !== ch.project_id) return;

  const userId = String(p.user?.id ?? "");
  const who = await userName(install.bot_token, teamId, userId);
  recordWisdomFeedback({
    groupId: ch.project_id, insightId: finding.id, member: who, verdict,
    sourceEventId: `slack:${teamId}:${userId}:${finding.id}`,
  });
  log(`feedback ${verdict} on ${finding.id.slice(0, 8)} in #${ch.channel_name || channelId}`);
  if (p.response_url) {
    await respondTo(String(p.response_url), { response_type: "ephemeral", replace_original: false, text: `Thanks, recorded as ${verdict}.` })
      .catch(() => { /* the verdict is stored; the thank-you is a courtesy */ });
  }
}

// ── Wisdom → back into the channel ──────────────────────────────────────────

/**
 * Post findings into the channel they were drawn for, as a reply to the
 * message that completed them, also shown in the channel. Exported for tests.
 */
export async function postSlackFindings(teamId: string, channelId: string, wisdom: Insight[], threadTs?: string) {
  const install = getSlackInstall(teamId);
  const ch = getSlackChannel(teamId, channelId);
  if (!install || !ch || !ch.active) return;

  if (mutedNow(ch)) {
    log(`${wisdom.length} finding(s) withheld — #${ch.channel_name || channelId} is muted`);
    return;
  }

  for (const w of wisdom) {
    if (w.group_id !== ch.project_id) continue;
    if (w.channel && w.channel !== channelKey(channelId)) continue;
    // Claimed before posting, not after: two overlapping analyses would otherwise both say it.
    if (!claimSlackPost(teamId, channelId, w.id)) continue;
    try {
      const msg = slackFindingMessage(w);
      const sent = await postMessage(install.bot_token, {
        channel: channelId, text: msg.text, blocks: msg.blocks,
        ...(threadTs ? { thread_ts: threadTs, reply_broadcast: true } : {}),
      });
      recordSlackPost(teamId, channelId, w.id, sent.ts);
      log(`posted ${w.kind} to #${ch.channel_name || channelId}`);
    } catch (e) {
      releaseSlackPost(teamId, channelId, w.id);        // a post that failed never happened
      log(`post failed, released claim: ${(e as Error).message}`);
    }
  }
}

async function say(install: SlackInstall, channelId: string, text: string, threadTs?: string) {
  try {
    await postMessage(install.bot_token, { channel: channelId, text, ...(threadTs ? { thread_ts: threadTs } : {}) });
  } catch (e) {
    log(`could not speak in ${channelId}: ${(e as Error).message}`);
  }
}

// ── Installing, from our side ───────────────────────────────────────────────

const sessionUser = (req: any) => (req.session?.userId ? getUserById(req.session.userId) : undefined);

function authUser(req: any) {
  const key = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (key) return getUserByApiKey(key);
  return sessionUser(req);
}

const slackConfigured = () =>
  Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET && process.env.SLACK_SIGNING_SECRET);

/** Whether this server can take an install, so the setup page never offers a dead button. */
slackHook.get("/status", (_req, res) => {
  res.json({ configured: slackConfigured(), consent_version: SLACK_CONSENT_VERSION, scopes: SLACK_SCOPES });
});

/**
 * Start an install. The person must be signed in, so the workspace is bound to
 * their account the moment it comes back, and must have agreed to the current
 * consent wording on /slack.
 */
slackHook.get("/install", (req: any, res) => {
  if (!slackConfigured()) return res.redirect("/slack?error=not_configured");
  const user = sessionUser(req);
  if (!user) return res.redirect("/slack?error=signin");
  if (req.query.consent !== SLACK_CONSENT_VERSION) return res.redirect("/slack?error=consent");

  const state = createSlackOAuthState(user.id, SLACK_CONSENT_VERSION);
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", String(process.env.SLACK_CLIENT_ID));
  url.searchParams.set("scope", SLACK_SCOPES.join(","));
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

slackHook.get("/oauth/callback", async (req: any, res) => {
  const fail = (code: string, why: string) => {
    log(`install did not complete: ${why}`);           // the reason to our log, a code to the page
    res.redirect(`/slack?error=${code}`);
  };
  if (req.query.error) return fail("cancelled", `Slack returned ${req.query.error}`);

  const st = consumeSlackOAuthState(String(req.query.state ?? ""));
  if (!st) return fail("expired", "unknown, used or expired state");
  const user = sessionUser(req);
  if (!user || user.id !== st.user_id) return fail("signin", "the install was started in a different session");
  const code = String(req.query.code ?? "");
  if (!code) return fail("cancelled", "no code");

  let data: any;
  try { data = await oauthAccess(code, REDIRECT_URI); }
  catch (e) { return fail("exchange", (e as Error).message); }

  if (data.is_enterprise_install) return fail("enterprise", "organisation-wide installs are not supported yet");
  const teamId = String(data.team?.id ?? "");
  if (!teamId || !data.access_token) return fail("exchange", "no workspace or token in the response");

  const existing = getSlackInstall(teamId);
  if (existing && existing.installed_by !== user.id) return fail("taken", "workspace already connected to another account");

  upsertSlackInstall({
    teamId,
    teamName: String(data.team?.name ?? ""),
    botToken: String(data.access_token),
    botUserId: String(data.bot_user_id ?? ""),
    appId: String(data.app_id ?? ""),
    scope: String(data.scope ?? ""),
    installedBy: user.id,
    consentVersion: st.consent_version,
  });
  log(`installed in ${data.team?.name ?? teamId}`);
  res.redirect(`/slack?installed=${encodeURIComponent(String(data.team?.name ?? ""))}`);
});

/** Your workspaces, and the channels each one has invited GroupWisdom to. */
slackHook.get("/installs", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "Invalid or missing API key." });
  res.json({
    data: listSlackInstallsForUser(user.id).map(i => ({
      team_id: i.team_id,
      team_name: i.team_name,
      installed_at: i.created_at,
      channels: listSlackChannels(i.team_id).map(c => ({
        channel_id: c.channel_id,
        channel_name: c.channel_name,
        project_id: c.project_id,
        active: Boolean(c.active),
        muted: mutedNow(c),
      })),
    })),
  });
});

/**
 * Disconnect a workspace. Slack is asked to remove the app, and everything the
 * workspace gave us is deleted here whether or not Slack answers: removing our
 * copy is the part we are responsible for.
 */
slackHook.delete("/installs/:teamId", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "Invalid or missing API key." });
  const install = getSlackInstall(req.params.teamId);
  if (!install) return res.status(404).json({ error: "No such workspace." });
  if (install.installed_by !== user.id) return res.status(403).json({ error: "That workspace is not yours." });

  try { await appsUninstall(install.bot_token); }
  catch (e) { log(`apps.uninstall for ${install.team_id} did not complete: ${(e as Error).message}`); }
  const n = deleteSlackWorkspace(install.team_id);
  res.json({ disconnected: true, deleted_projects: n });
});

// ── Retention ───────────────────────────────────────────────────────────────
// Raw Slack messages are kept thirty days, then deleted; the engine needs them
// only for its short conversational tail, and memory has long since absorbed
// what mattered. Run here rather than in index.ts so the Slack policy lives
// with the Slack code.

const SLACK_RETENTION_DAYS = Number(process.env.GW_SLACK_RETENTION_DAYS ?? 30);
function pruneSlack() {
  try {
    const n = pruneOldSlackItems(SLACK_RETENTION_DAYS);
    if (n) log(`retention: deleted ${n} message(s) older than ${SLACK_RETENTION_DAYS} days`);
  } catch (e) { log(`retention failed: ${(e as Error).message}`); }
}
setTimeout(pruneSlack, 10_000).unref();
setInterval(pruneSlack, 6 * 60 * 60 * 1000).unref();
