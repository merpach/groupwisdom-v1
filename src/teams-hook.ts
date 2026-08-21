/**
 * Microsoft Teams — mounted at /teams.
 *
 * The Buzz adapter holds a websocket open and keeps its state in memory. Teams
 * does the opposite: it POSTs each message to us and forgets we exist, so this
 * file is a request handler over the tables in db.ts rather than a loop.
 *
 *   Teams channel ──(Bot Framework)──▶ POST /teams/messages
 *                                             │
 *                                     GroupWisdom engine
 *                                             │
 *   Teams channel ◀──(Bot Connector)──── POST {serviceUrl}/v3/conversations/…
 *
 * Nothing is read from a team until a person has bound it to a project. On
 * install the bot posts a pairing code and says nothing else; someone with a
 * GroupWisdom account redeems it at /teams. Until then every message is dropped
 * unread. The decision to let a team's messages leave Teams is made by a person,
 * in our product, on purpose — not implied by an admin clicking Install.
 *
 * Endpoints:
 *   POST /teams/messages   — the Bot Framework endpoint (Microsoft calls this)
 *   POST /teams/claim      — redeem a pairing code against one of your projects
 *   GET  /teams/installs   — the teams bound to your projects
 *   DELETE /teams/installs/:teamId — unbind a team
 */
import { Router } from "express";
import {
  verifyInboundJwt,
  isTrustedServiceUrl,
  postActivity,
} from "./adapters/teams-client.js";
import {
  shouldIngest,
  activityToItem,
  conversationRefOf,
  channelKeyOf,
  teamsCommand,
  teamsCardActivity,
  teamsTextActivity,
  mentionsUs,
  type TeamsActivity,
} from "./adapters/teams.js";
import { muteUntil, isMutedAt, MUTE_FOREVER } from "./adapters/buzz.js";
import {
  getUserById,
  getUserByApiKey,
  getGroup,
  getGroupsForUser,
  listMembers,
  addMember,
  addItem,
  startTeamsPairing,
  getPendingTeamsInstall,
  claimTeamsPairing,
  deletePendingTeamsInstall,
  getTeamsInstall,
  getTeamsInstallForProject,
  deleteTeamsInstall,
  listTeamsConversations,
  rememberTeamsConversation,
  getTeamsConversation,
  setTeamsMute,
  claimTeamsPost,
  releaseTeamsPost,
  recordTeamsPost,
  type Insight,
  type TeamsConversation,
} from "./db.js";
import { queueIncrementalAnalysis } from "./engine.js";

export const teamsHook = Router();

const MAX_CONTENT = 4000;
const PUBLIC_BASE = process.env.GW_PUBLIC_URL || "https://testgroupwisdom.com";

const log = (m: string) => console.log("[teams]", m);

// ── The Bot Framework endpoint ──────────────────────────────────────────────

/**
 * Every inbound activity, verified before it is read.
 *
 * This URL is public and accepts JSON describing what people said. Without the
 * signature check anyone who learned the address could post fabricated messages
 * attributed to real colleagues, into a real customer's project, billed to that
 * customer's allowance. So the token is checked first and the body is not
 * touched until it passes.
 *
 * Microsoft retries on anything but a prompt 2xx, and a retry would double-count
 * the message. So the response goes out as soon as the activity is authentic,
 * and the work happens after.
 */
teamsHook.post("/messages", async (req, res) => {
  const verdict = await verifyInboundJwt(req.headers.authorization as string | undefined);
  if (!verdict.ok) {
    // The reason is logged, never returned: telling a caller which check failed
    // is telling them how to pass it.
    log(`rejected inbound activity: ${verdict.reason}`);
    return res.status(401).json({ error: "Unauthorized." });
  }

  const activity = (req.body ?? {}) as TeamsActivity;

  // serviceUrl comes from the request body and becomes the destination of an
  // authenticated POST carrying our bot token. A verified token makes a forgery
  // hard already; this makes aiming it somewhere else impossible.
  if (!isTrustedServiceUrl(String(activity.serviceUrl ?? ""))) {
    log(`rejected activity with untrusted serviceUrl ${activity.serviceUrl}`);
    return res.status(400).json({ error: "Bad request." });
  }

  res.status(200).end();

  handleActivity(activity).catch(e => log(`handler failed: ${(e as Error).message}`));
});

async function handleActivity(activity: TeamsActivity) {
  const teamId = activity?.channelData?.team?.id ?? "";

  if (activity.type === "installationUpdate") return handleInstallation(activity, teamId);
  if (activity.type === "conversationUpdate") return handleConversationUpdate(activity, teamId);
  if (activity.type !== "message") return;

  const install = teamId ? getTeamsInstall(teamId) : undefined;
  if (!install) return handleUnpairedMessage(activity, teamId);

  return handleMessage(activity, install.project_id);
}

// ── Install and pairing ─────────────────────────────────────────────────────

async function handleInstallation(activity: TeamsActivity, teamId: string) {
  const action = String((activity as any)?.action ?? "").toLowerCase();
  if (action === "remove" || action === "removeupgrade") {
    if (teamId) {
      deleteTeamsInstall(teamId);
      deletePendingTeamsInstall(teamId);
      log(`uninstalled from team ${teamId.slice(0, 12)}…`);
    }
    return;
  }
  if (teamId) await offerPairing(activity, teamId);
}

/**
 * Teams announces an install as a conversationUpdate carrying our own id in
 * membersAdded, and sends installationUpdate as well. Both paths land on the
 * same idempotent pairing call, so whichever arrives first wins and the second
 * changes nothing.
 */
async function handleConversationUpdate(activity: TeamsActivity, teamId: string) {
  const me = String(activity?.recipient?.id ?? "");
  const added = ((activity as any)?.membersAdded ?? []) as Array<{ id?: string }>;
  const weWereAdded = me && added.some(m => String(m?.id ?? "") === me);
  if (weWereAdded && teamId) await offerPairing(activity, teamId);
}

async function offerPairing(activity: TeamsActivity, teamId: string) {
  if (getTeamsInstall(teamId)) return;                  // already bound; nothing to offer

  const ref = conversationRefOf(activity);
  const pending = startTeamsPairing({
    teamId,
    tenantId: activity?.channelData?.tenant?.id ?? "",
    teamName: activity?.channelData?.team?.name ?? "",
    serviceUrl: ref?.serviceUrl ?? "",
    conversationId: ref?.conversationId ?? "",
  });

  if (!ref) return;
  await say(ref, pairingMessage(pending.code));
  log(`offered pairing code to team ${teamId.slice(0, 12)}…`);
}

const pairingMessage = (code: string) =>
  `I am not reading anything yet.\n\n` +
  `To connect this team, go to ${PUBLIC_BASE}/teams and enter this code:\n\n` +
  `${code}\n\n` +
  `Whoever enters it chooses which GroupWisdom project this team belongs to. ` +
  `Until then I will not read a single message. The code lasts 24 hours.`;

/**
 * A message in a team nobody has claimed.
 *
 * Silence is the default — an unpaired team is one we have no permission to
 * read. Being spoken to directly is the exception, because someone asking the
 * bot a question deserves to know why it is not answering.
 */
async function handleUnpairedMessage(activity: TeamsActivity, teamId: string) {
  if (!teamId || !mentionsUs(activity)) return;

  const ref = conversationRefOf(activity);
  if (!ref) return;

  const pending = getPendingTeamsInstall(teamId) ?? startTeamsPairing({
    teamId,
    tenantId: activity?.channelData?.tenant?.id ?? "",
    teamName: activity?.channelData?.team?.name ?? "",
    serviceUrl: ref.serviceUrl,
    conversationId: ref.conversationId,
  });
  await say(ref, pairingMessage(pending.code));
}

// ── A message in a paired team ──────────────────────────────────────────────

async function handleMessage(activity: TeamsActivity, projectId: string) {
  const channel = channelKeyOf(activity);
  const ref = conversationRefOf(activity);
  if (!channel || !ref) return;

  // Every inbound message refreshes where we reply. serviceUrl is regional and
  // documented as per-conversation, so the freshest one is the right one.
  rememberTeamsConversation({
    channelId: channel,
    teamId: activity?.channelData?.team?.id ?? "",
    conversationId: ref.conversationId,
    serviceUrl: ref.serviceUrl,
    tenantId: ref.tenantId ?? "",
    channelName: activity?.channelData?.channel?.name ?? "",
    replyToId: ref.replyToId,
  });

  const cmd = teamsCommand(activity);
  if (cmd) return handleCommand(cmd, channel, ref, projectId);

  if (!shouldIngest(activity)) return;

  const project = getGroup(projectId);
  if (!project) {
    log(`team points at project ${projectId} which no longer exists`);
    return;
  }

  const draft = activityToItem(activity);
  const content = String(draft.content).slice(0, MAX_CONTENT);
  if (!content.trim()) return;

  const contributor = String(draft.contributed_by).slice(0, 64) || "unknown";
  const members = listMembers(projectId);
  const member = members.find(m => m.name === contributor) ?? addMember(projectId, contributor, "teams");

  const item = addItem(projectId, {
    member_id: member.id,
    type: "note",
    title: draft.title,
    content,
    source: "teams",
    channel,                       // scopes the scan, and what may be said here
  });

  queueIncrementalAnalysis(projectId, item, async (wisdom: Insight[]) => {
    if (wisdom?.length) await postFindings(channel, wisdom);
  });
}

// ── Commands ────────────────────────────────────────────────────────────────

async function handleCommand(
  cmd: { name: string; args: string },
  channel: string,
  ref: NonNullable<ReturnType<typeof conversationRefOf>>,
  _projectId: string,
) {
  const now = Date.now();

  if (cmd.name === "mute") {
    const until = muteUntil(cmd.args, now);
    setTeamsMute(channel, until);
    await say(ref, until === MUTE_FOREVER
      ? "Quiet from here. I will keep reading, and I will still answer if you ask me something directly."
      : "Quiet for the rest of the day. I will keep reading, and I will still answer if you ask me something directly.");
    return;
  }

  if (cmd.name === "unmute") {
    setTeamsMute(channel, -1);
    await say(ref, "Back on.");
    return;
  }

  // `memory` and `demo` are answered by the Buzz adapter and not yet wired here.
  // Saying so is better than silence, which reads as the bot being broken.
  if (cmd.name === "memory" || cmd.name === "demo") {
    await say(ref, `\`${cmd.name}\` is not available in Teams yet.`);
    return;
  }
}

// ── Wisdom → back into the channel ──────────────────────────────────────────

/** Is this channel currently silenced? */
function mutedNow(conv: TeamsConversation | undefined, now = Date.now()): boolean {
  if (!conv) return false;
  if (conv.muted_until < 0) return false;                        // never muted
  return isMutedAt(conv.muted_until, now);
}

async function postFindings(channel: string, wisdom: Insight[]) {
  const conv = getTeamsConversation(channel);
  if (!conv) return;

  if (mutedNow(conv)) {
    log(`${wisdom.length} finding(s) withheld — ${channel.slice(0, 12)}… is muted`);
    return;
  }

  for (const w of wisdom) {
    // A finding built from another channel's work has no business being read
    // out here, whatever the engine decided.
    if (w.channel && w.channel !== channel) continue;

    // Claimed before posting, not after: two overlapping analyses both asking
    // "have we said this?" would both see no and both say it.
    if (!claimTeamsPost(channel, w.id)) continue;

    try {
      const sent = await postActivity(
        { serviceUrl: conv.service_url, conversationId: conv.conversation_id },
        teamsCardActivity(w.kind, w.title, w.body ?? "", conv.reply_to_id),
      );
      recordTeamsPost(channel, w.id, sent?.id ?? null);
      log(`posted ${w.kind} to ${channel.slice(0, 12)}…`);
    } catch (e) {
      // The claim is the lock. A post that failed never happened, so release it
      // or the finding is lost for good.
      releaseTeamsPost(channel, w.id);
      log(`post failed, released claim: ${(e as Error).message}`);
    }
  }
}

async function say(
  ref: { serviceUrl: string; conversationId: string; replyToId?: string | null },
  text: string,
) {
  try {
    await postActivity(
      { serviceUrl: ref.serviceUrl, conversationId: ref.conversationId },
      teamsTextActivity(text, ref.replyToId ?? null),
    );
  } catch (e) {
    log(`could not speak: ${(e as Error).message}`);
  }
}

// ── Pairing, from our side ──────────────────────────────────────────────────

function authUser(req: any) {
  const key = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (key) return getUserByApiKey(key);
  return req.session?.userId ? getUserById(req.session.userId) : undefined;
}

/** Redeem a code against a project you own. */
teamsHook.post("/claim", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "Invalid or missing API key." });

  const { code, project_id } = req.body ?? {};
  if (!code || !project_id) return res.status(400).json({ error: "code and project_id are required." });

  // Checked against the caller's own projects, so a valid code cannot be pointed
  // at a project the caller does not own.
  const owned = getGroupsForUser(user.id).some((g: any) => g.id === project_id);
  if (!owned) return res.status(403).json({ error: "That project is not yours." });

  const install = claimTeamsPairing(String(code), String(project_id));
  if (!install) {
    return res.status(404).json({ error: "That code is not valid, has expired, or the team is already connected." });
  }

  const conv = listTeamsConversations(install.team_id)[0];
  if (conv) {
    say({ serviceUrl: conv.service_url, conversationId: conv.conversation_id },
      `Connected. I will read this team's channels from here and speak when two pieces of work add up to something neither said alone. Most of the time I will say nothing.`)
      .catch(() => { /* the binding is what matters; the greeting is not */ });
  }

  log(`team ${install.team_id.slice(0, 12)}… bound to project ${project_id}`);
  res.json({ connected: true, team_id: install.team_id, team_name: install.team_name, project_id });
});

/** The teams bound to your projects. */
teamsHook.get("/installs", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "Invalid or missing API key." });

  const data = (getGroupsForUser(user.id) as any[]).flatMap(g => {
    const install = getTeamsInstallForProject(g.id);
    if (!install) return [];
    return [{
      team_id: install.team_id,
      team_name: install.team_name,
      project_id: g.id,
      project_name: g.name,
      channels: listTeamsConversations(install.team_id).map(c => ({
        channel_id: c.channel_id,
        channel_name: c.channel_name,
        muted: mutedNow(c),
      })),
    }];
  });

  res.json({ data });
});

/** Unbind a team. The app stays installed in Teams; we simply stop reading. */
teamsHook.delete("/installs/:teamId", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "Invalid or missing API key." });

  const install = getTeamsInstall(req.params.teamId);
  if (!install) return res.status(404).json({ error: "No such team." });

  const owned = getGroupsForUser(user.id).some((g: any) => g.id === install.project_id);
  if (!owned) return res.status(403).json({ error: "That team is not yours." });

  deleteTeamsInstall(install.team_id);
  res.json({ disconnected: true });
});
