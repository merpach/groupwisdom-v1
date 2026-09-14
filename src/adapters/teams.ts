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
    channel?: { id?: string; name?: string; membershipType?: string };  // Graph's name for the channel type
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
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}

/**
 * The few HTML entities Teams can leave in message text.
 *
 * A client that puts a non-breaking space after a mention sends
 * "<at>GroupWisdom</at>&nbsp;memory". Undecoded, the command reads as
 * "&nbsp;memory" and is missed, so the person asking gets silence, and the same
 * entities would reach the engine as literal text. Ampersand goes last so
 * "&amp;lt;" becomes "&lt;" rather than "<".
 */
export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
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
 *
 * Two fields are checked because which one Teams sends is not pinned down:
 * channelType on channelData, and membershipType on the channel, which is what
 * Microsoft Graph calls it. The manifest is the real barrier, since it declares
 * no support for non-standard channels, so this can only narrow what is read.
 * A type that is present and is not "standard" is refused in either place.
 */
export const canSpeakIn = (activity: TeamsActivity): boolean =>
  [activity?.channelData?.channelType, activity?.channelData?.channel?.membershipType]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .every(x => x.toLowerCase() === "standard");

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
 * A message carrying an Adaptive Card attachment. Distinct from
 * teamsCardActivity above, which renders a wisdom card as plain text.
 * `text` is what a client shows if it cannot render the card.
 */
export function teamsAdaptiveCardActivity(text: string, card: Record<string, unknown>, replyToId?: string | null) {
  return {
    type: "message",
    textFormat: "plain",
    text: String(text ?? ""),
    attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }],
    ...(replyToId ? { replyToId } : {}),
  };
}

/**
 * The pairing offer, as a card with a button.
 *
 * The code used to be read off the screen and retyped on the website. It is
 * still shown, for anyone who would rather do that, but the button carries it
 * in the link, so the ordinary path is press, sign in, pick a project.
 */
export function pairingCard(code: string, connectUrl: string) {
  return {
    type: "AdaptiveCard",
    version: "1.4",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    body: [
      { type: "TextBlock", text: "I am not reading anything yet.", weight: "Bolder", wrap: true },
      { type: "TextBlock", wrap: true,
        text: "Whoever connects this team chooses which GroupWisdom project it belongs to. Until then I will not read a single message." },
      { type: "TextBlock", text: code, fontType: "Monospace", size: "ExtraLarge", weight: "Bolder", wrap: true },
      { type: "TextBlock", text: "The code lasts 24 hours. It is already in the button.", isSubtle: true, size: "Small", wrap: true },
    ],
    actions: [{ type: "Action.OpenUrl", title: "Connect this team", url: connectUrl }],
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


// ── "@GroupWisdom memory" ────────────────────────────────────────────────────

// Index signatures so the scoped memory from channel-scope, which is typed
// loosely, passes straight in. Only the named fields are ever read.
export type MemoryForReply = {
  facts?: Array<{ fact?: string; by?: string; sources?: string[]; [k: string]: unknown }>;
  decisions?: Array<{ decision?: string; [k: string]: unknown }>;
  open_questions?: string[];
  active_wisdom?: unknown[];
};

/**
 * What the engine believes this team has established, as a chat message.
 *
 * Ported line for line from the Buzz adapter so the two surfaces give the
 * same answer to the same question. A chat message, not a report: long enough
 * to be checkable, short enough that someone reads it. Facts quote the message
 * they came from, once per source, so a claim can be traced without an id.
 *
 * Pure, so it is testable without Bot Framework in the loop.
 */
export function formatMemoryReply(
  mem: MemoryForReply,
  items: Array<{ id: string; content?: string | null; title?: string | null }>,
  opts: { scoped: boolean; hidden: number; muted: boolean },
): string {
  const byShortId = new Map<string, { content?: string | null; title?: string | null }>();
  for (const it of items) byShortId.set(String(it.id).slice(0, 8), it);
  const quoteFor = (sources: string[] = [], len = 45) => {
    for (const sid of sources) {
      const it = byShortId.get(sid);
      const text = String(it?.content ?? it?.title ?? "").replace(/\s+/g, " ").trim();
      if (text) return truncate(text, len) + (text.length > len ? "…" : "");
    }
    return "";
  };
  const FACT_LINE = 110, QUOTE_LEN = 45, MAX_FACTS = 8, MAX_QUESTIONS = 5;
  /** A contributor we never learned a name for is an id. Leave it off rather than print it. */
  const namePart = (by?: string) => (by && !/^[0-9a-f]{8,}$/i.test(by.trim())) ? ` (${by})` : "";

  const lines: string[] = [opts.scoped ? "Here is what I know from this channel." : "Here is what I know so far."];
  let lastQuote = "";
  const facts = mem.facts ?? [];
  if (facts.length) {
    lines.push("", "What I have established:");
    for (const f of facts.slice(-MAX_FACTS).reverse()) {
      const raw = String(f.fact ?? "").trim();
      const fact = truncate(raw, FACT_LINE) + (raw.length > FACT_LINE ? "…" : "");
      const q = quoteFor(f.sources, QUOTE_LEN);
      const quote = q && q !== lastQuote ? ` — from “${q}”` : "";
      if (q) lastQuote = q;
      lines.push(`• ${fact}${namePart(f.by)}${quote}`);
    }
  }
  const decisions = mem.decisions ?? [];
  if (decisions.length) {
    lines.push("", "What you have decided:");
    for (const d of decisions.slice(-4).reverse()) lines.push(`• ${truncate(String(d.decision ?? "").trim(), FACT_LINE)}`);
  }
  const questions = mem.open_questions ?? [];
  if (questions.length) {
    lines.push("", "Still open:");
    for (const q of questions.slice(0, MAX_QUESTIONS)) lines.push(`• ${truncate(String(q).trim(), FACT_LINE)}`);
    if (questions.length > MAX_QUESTIONS) lines.push(`…and ${questions.length - MAX_QUESTIONS} more.`);
  }
  // Spoken-finding count is team-wide; it would overstate a scoped answer.
  const spoken = opts.scoped ? 0 : (mem.active_wisdom?.length ?? 0);
  if (spoken) lines.push("", `I have shared ${spoken} finding${spoken === 1 ? "" : "s"} from this, and will not repeat ${spoken === 1 ? "it" : "them"}.`);
  if (opts.scoped && opts.hidden) lines.push("", "I also hold notes from other channels here. Those stay in the channel they came from.");
  if (opts.muted) lines.push("", "I am muted in this channel. Say @GroupWisdom unmute to hear from me again.");
  return lines.join("\n");
}
