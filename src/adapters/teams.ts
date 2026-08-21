/**
 * Microsoft Teams adapter — GroupWisdom as an agent inside a Teams team.
 *
 * Same job as the Buzz adapter and the same relationship to the rest of the
 * system: it talks to GroupWisdom over the public /v1 API and imports neither
 * the engine nor the database. What differs is the transport. Buzz is an
 * outbound websocket we hold open; Teams pushes each message to us over HTTP,
 * so this half is pure translation and the connection half is a route.
 *
 * The permission model is the reason this is viable at all. By default a Teams
 * bot only receives messages that @mention it, which would make the product
 * impossible: it needs to read a room, not its own mail. Resource-specific
 * consent changes that. With `ChannelMessage.Read.Group` declared in the app
 * manifest, a bot installed into a team receives every message in that team's
 * channels, and the consent is granted by the team owner rather than a tenant
 * administrator. One team, granted by the person who owns it, is the same shape
 * as being invited to a Buzz channel.
 *
 * Two Teams limits shape what follows:
 *   - Bots cannot post messages or Adaptive Cards in private channels, so a
 *     finding drawn there has nowhere to go. Read them or not, it can never
 *     answer, so this adapter declines to ingest them at all rather than
 *     collect content it can do nothing with.
 *   - Posting later requires a conversation reference kept from an earlier
 *     inbound activity, because Teams gives no standing connection to write
 *     down. Analysis finishes seconds after the message, so the reference is
 *     always fresh, but it has to be captured on the way in.
 *
 * Wire reference: Bot Framework Activity schema, and Microsoft Teams
 * conversation docs for channelData, mention entities and threading.
 */
import { truncate } from "../text-util.js";

/**
 * The conventions here (two marks, a headline, no labels) are the product's
 * rather than Buzz's, and are imported rather than copied so the two surfaces
 * cannot drift apart. If a third adapter ever appears they should move to a
 * module of their own; two does not justify the indirection yet.
 */
export { markFor, formatCard, parseCommand } from "./buzz.js";
import { formatCard, parseCommand } from "./buzz.js";

// ── The shape Teams sends us ────────────────────────────────────────────────

export type TeamsAccount = { id?: string; name?: string; aadObjectId?: string };

export type TeamsMention = {
  type?: string;
  text?: string;
  mentioned?: TeamsAccount;
};

export type TeamsActivity = {
  type?: string;
  id?: string;
  text?: string;
  timestamp?: string;
  serviceUrl?: string;
  channelId?: string;                    // always "msteams" for us, not the channel
  from?: TeamsAccount;
  recipient?: TeamsAccount;              // our bot
  conversation?: { id?: string; conversationType?: string; isGroup?: boolean };
  entities?: TeamsMention[];
  replyToId?: string;
  channelData?: {
    tenant?: { id?: string };
    team?: { id?: string; name?: string };
    channel?: { id?: string; name?: string };
    channelType?: string;                // "private" and "shared" are not "standard"
    eventType?: string;                  // editMessage, deleteMessage, and so on
  };
};

/**
 * Everything needed to post back into the conversation this arrived from.
 *
 * `serviceUrl` is per tenant and per region and is not a constant: Microsoft
 * documents it as something to read from the activity rather than hardcode, so
 * it is stored alongside the conversation rather than configured once.
 */
export type ConversationRef = {
  serviceUrl: string;
  conversationId: string;
  tenantId: string | null;
  teamId: string | null;
  channelId: string | null;
  /** The inbound activity id, so a reply can thread under it. */
  replyToId: string | null;
};

// ── Reading an activity ─────────────────────────────────────────────────────

/**
 * Strip mention markup, using the entities rather than the text.
 *
 * Microsoft is explicit that the text is not trustworthy for this: "don't rely
 * on the text in the message to retrieve any information about the user. It's
 * possible for the person sending the message to alter it." Each mention entity
 * carries the exact markup it inserted, so removing those strings is the only
 * reliable way to get back to what the person actually wrote.
 */
export function stripMentions(activity: TeamsActivity): string {
  let text = String(activity?.text ?? "");
  for (const e of activity?.entities ?? []) {
    if (e?.type === "mention" && e.text) text = text.split(e.text).join(" ");
  }
  return text.replace(/\s+/g, " ").trim();
}

/** Was our bot among the mentions? Compared on id, never on the display name. */
export function mentionsUs(activity: TeamsActivity, botId?: string): boolean {
  const me = String(botId ?? activity?.recipient?.id ?? "");
  if (!me) return false;
  return (activity?.entities ?? []).some(
    e => e?.type === "mention" && String(e.mentioned?.id ?? "") === me,
  );
}

/**
 * The room this belongs to, which becomes our `channel` and decides what a
 * finding posted here may be built from.
 *
 * A team channel has a stable channel id. A group chat has none, so the
 * conversation id stands in — it is equally stable and equally bounded, which
 * is all the scoping rule needs.
 */
export function channelKeyOf(activity: TeamsActivity): string | null {
  const ch = activity?.channelData?.channel?.id;
  if (ch) return ch;
  // A channel conversation id carries a thread suffix; the room is the part before it.
  const conv = String(activity?.conversation?.id ?? "");
  return conv ? conv.split(";")[0] : null;
}

/**
 * Private and shared channels are declined, because a bot cannot post into
 * them. Reading a room we can never answer would collect content to no purpose,
 * and would quietly bill for it.
 */
export const canSpeakIn = (activity: TeamsActivity): boolean => {
  const t = activity?.channelData?.channelType;
  return !t || t === "standard";
};

/** Our own posts come back to us in some configurations. They are never input. */
export function isOwnMessage(activity: TeamsActivity, botId?: string): boolean {
  const me = String(botId ?? activity?.recipient?.id ?? "");
  const from = String(activity?.from?.id ?? "");
  return !!me && !!from && me === from;
}

/**
 * Is this something to read at all?
 *
 * Edits and deletions arrive as message activities carrying a channelData
 * eventType. They are real signals the engine should eventually act on, but
 * treating an edit as a new contribution would double-count the same work, so
 * for now they are skipped rather than mishandled.
 */
export function shouldIngest(activity: TeamsActivity, botId?: string): boolean {
  if (activity?.type !== "message") return false;
  if (activity?.channelData?.eventType) return false;
  if (isOwnMessage(activity, botId)) return false;
  if (!canSpeakIn(activity)) return false;
  if (!channelKeyOf(activity)) return false;
  return stripMentions(activity).length > 0;
}

/** The ingest body for POST /v1/projects/:id/ingest. */
export function activityToItem(activity: TeamsActivity, botId?: string) {
  const content = stripMentions(activity);
  return {
    title: truncate(content, 60) || "(message)",
    content,
    type: "note",
    contributed_by: String(activity?.from?.name ?? "").trim() || "unknown",
    channel: channelKeyOf(activity) ?? undefined,
  };
}

/** What we need to keep in order to answer later. */
export function conversationRefOf(activity: TeamsActivity): ConversationRef | null {
  const serviceUrl = String(activity?.serviceUrl ?? "").replace(/\/+$/, "");
  const conversationId = String(activity?.conversation?.id ?? "");
  if (!serviceUrl || !conversationId) return null;
  return {
    serviceUrl,
    conversationId,
    tenantId: activity?.channelData?.tenant?.id ?? null,
    teamId: activity?.channelData?.team?.id ?? null,
    channelId: channelKeyOf(activity),
    replyToId: activity?.id ?? null,
  };
}

/**
 * A command addressed to us, if this is one.
 *
 * With RSC every message arrives, so the mention is what separates "asking the
 * agent" from "talking to colleagues". A message that does not name us is
 * ordinary work and goes to the engine, never to the dispatcher.
 */
export function teamsCommand(activity: TeamsActivity, botId?: string) {
  const text = stripMentions(activity);
  return parseCommand(text, { taggedUs: mentionsUs(activity, botId) });
}

// ── Writing back ────────────────────────────────────────────────────────────

/**
 * A finding as a Teams message.
 *
 * Plain text with the same mark and headline as everywhere else, deliberately
 * not an Adaptive Card. A card renders as a coloured box that reads as a
 * notification from a system, and the whole design is that a finding arrives
 * looking like something a colleague said.
 */
export function teamsCardActivity(kind: string, title: string, body: string, replyToId?: string | null) {
  return {
    type: "message",
    textFormat: "plain",
    text: formatCard(kind, title, body),
    ...(replyToId ? { replyToId } : {}),
  };
}

/** A plain reply, for command answers and notices. */
export function teamsTextActivity(text: string, replyToId?: string | null) {
  return {
    type: "message",
    textFormat: "plain",
    text: String(text ?? ""),
    ...(replyToId ? { replyToId } : {}),
  };
}

/**
 * Where a reply goes.
 *
 * Posting to a conversation id that carries a `messageid=` suffix continues
 * that thread; posting to the bare id starts a new one in the channel. A
 * finding about a message belongs under it, so the suffix is kept when present.
 */
export function replyUrl(ref: ConversationRef): string {
  return `${ref.serviceUrl}/v3/conversations/${encodeURIComponent(ref.conversationId)}/activities`;
}
