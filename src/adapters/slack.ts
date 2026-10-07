/**
 * Slack: everything that can be decided without the network.
 *
 * Kept pure so the rules that matter — is this request really from Slack, is
 * this message something a person wrote, what does it say once the markup is
 * gone, what does a finding look like in a channel — are tested directly,
 * without a workspace or a token in the loop. The handlers live in
 * src/slack-hook.ts and the Web API calls in ./slack-client.ts.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { parseCommand, markFor } from "./buzz.js";
import { truncate } from "../text-util.js";

// ── Request signing ─────────────────────────────────────────────────────────

/** Slack's own examples reject anything older than five minutes. So do we. */
const MAX_SKEW_SECONDS = 5 * 60;

export type SignatureVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Was this request signed by Slack with our signing secret?
 *
 * The signature is an HMAC over the raw bytes, so this must run before any
 * parsing and against exactly what arrived. The reason is for our log, never
 * for the caller: telling a forger which check failed tells them how to pass.
 */
export function verifySlackSignature(
  secret: string | undefined,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: Buffer | string,
  nowMs = Date.now(),
): SignatureVerdict {
  if (!secret) return { ok: false, reason: "no signing secret configured" };
  if (!timestamp || !signature) return { ok: false, reason: "missing signature headers" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "malformed timestamp" };
  if (Math.abs(nowMs / 1000 - ts) > MAX_SKEW_SECONDS) return { ok: false, reason: "stale timestamp" };

  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}

// ── Which messages are someone's work ───────────────────────────────────────

export type SlackMessageEvent = {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  bot_profile?: unknown;
  text?: string;
  ts?: string;
  thread_ts?: string;
  hidden?: boolean;
  is_ext_shared_channel?: boolean;
};

/**
 * Subtypes that are still a person writing. Everything else — edits, deletes,
 * joins, topic changes, bot posts — is either not new work or not a person's.
 * An edit is skipped rather than re-read so a corrected typo is not a second
 * contribution.
 */
const READABLE_SUBTYPES = new Set(["thread_broadcast", "file_share"]);

/**
 * Should this message reach the engine?
 *
 * Public channels only: private channels, direct messages and group DMs are
 * never asked for and never read. Channels shared with another company are
 * refused as well — their people are not our customer's to consent for.
 */
export function shouldIngestSlack(ev: SlackMessageEvent, botUserId: string): boolean {
  if (ev?.type !== "message") return false;
  if (ev.channel_type !== "channel") return false;
  if (ev.is_ext_shared_channel) return false;
  if (ev.hidden) return false;
  if (ev.subtype && !READABLE_SUBTYPES.has(ev.subtype)) return false;
  if (ev.bot_id || ev.bot_profile) return false;
  if (!ev.user || ev.user === botUserId) return false;
  return Boolean(String(ev.text ?? "").trim());
}

// ── Slack markup to plain text ──────────────────────────────────────────────

/**
 * What a message says once Slack's markup is gone.
 *
 * Mentions become the person's name, because findings attribute work by name
 * and "<@U04ABC>" means nothing to the engine. `names` is whatever the caller
 * has already resolved; an id it could not resolve is left as "@someone"
 * rather than leaked as an id.
 */
export function slackTextToPlain(text: string, names: Map<string, string> = new Map()): string {
  return String(text ?? "")
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => "@" + (names.get(id) || label || "someone"))
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, _id: string, label?: string) => "#" + (label || "channel"))
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, label?: string) => (label ? (label.startsWith("@") ? label : "@" + label) : "@team"))
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_, w: string) => "@" + w)
    .replace(/<!date\^\d+\^[^|>]*\|([^>]*)>/g, (_, fallback: string) => fallback)
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_, url: string, label: string) => (label === url ? url : `${label} (${url})`))
    .replace(/<((?:https?|mailto):[^>]+)>/g, (_, url: string) => url)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();
}

/** The user ids a message mentions, so their names can be looked up first. */
export const mentionedUserIds = (text: string): string[] =>
  [...new Set([...String(text ?? "").matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map(m => m[1]))];

/** Does this message address the bot by mention? */
export const mentionsBot = (text: string, botUserId: string): boolean =>
  !!botUserId && new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`).test(String(text ?? ""));

/**
 * A command addressed to the bot by mention: "@GroupWisdom memory". The same
 * vocabulary as Teams and Buzz, so a person who has used one knows the others.
 * A mention that is not a command — a question, say — returns null and is read
 * as an ordinary contribution.
 */
export function slackMentionCommand(text: string, botUserId: string): { name: string; args: string } | null {
  if (!mentionsBot(text, botUserId)) return null;
  const rest = String(text).replace(new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g"), " ").trim();
  if (/^help\b/i.test(rest)) return { name: "help", args: "" };
  return parseCommand(slackTextToPlain(rest), { taggedUs: true });
}

/** `/groupwisdom memory` — the slash command's text, with no mention to strip. */
export function slackSlashCommand(text: string): { name: string; args: string } {
  const parsed = parseCommand(String(text ?? "").trim(), { taggedUs: true });
  return parsed ?? { name: "help", args: "" };
}

/** An item title from a message, the same derivation as the other adapters. */
export const slackItemTitle = (plain: string): string => truncate(plain.replace(/\s+/g, " "), 60) || "(message)";

// ── Writing back ────────────────────────────────────────────────────────────

/** Slack reads &, < and > as markup in every text field. */
export const escapeSlack = (s: string): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const FEEDBACK_ACTIONS: Record<string, "helpful" | "wrong" | "late"> = {
  gw_helpful: "helpful",
  gw_wrong: "wrong",
  gw_late: "late",
};

/**
 * A finding as a Slack message.
 *
 * The finding itself is an ordinary section of text with the same mark and
 * headline as everywhere else, so it reads as something a colleague said
 * rather than a system notification. Below it, three small buttons. They are
 * the only chrome, and they are there because whether a finding helped is the
 * one thing this product has never been able to measure.
 */
export function slackFindingMessage(w: { id: string; kind: string; title: string; body?: string | null }) {
  const title = escapeSlack(String(w.title ?? "").trim());
  const body = escapeSlack(String(w.body ?? "").trim());
  const button = (actionId: string, label: string) => ({
    type: "button",
    action_id: actionId,
    text: { type: "plain_text", text: label },
    value: w.id,
  });
  return {
    // The notification and screen-reader text, and what shows if blocks cannot render.
    text: `${markFor(w.kind)} ${String(w.title ?? "").trim()}: ${String(w.body ?? "").trim()}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${markFor(w.kind)} *${title}*\n${body}` } },
      {
        type: "actions",
        block_id: "gw_feedback",
        elements: [button("gw_helpful", "Helpful"), button("gw_wrong", "Wrong"), button("gw_late", "Late")],
      },
    ],
  };
}

/**
 * Said once, when the bot is invited to a channel. Everything a person in the
 * channel needs to know: what it does, what it keeps, where it goes, and how
 * to stop it. It is also the in-channel record that this channel was opted in.
 */
export const SLACK_WELCOME =
  "Hi, I'm GroupWisdom. From now on I read this channel and stay quiet unless two pieces of finished work " +
  "here add up to something neither said alone. Most of the time I say nothing.\n" +
  "Messages are stored encrypted for 30 days and analysed by Anthropic's Claude, which does not train on them. " +
  "I only read channels I'm invited to, and nothing I learn here is used anywhere else.\n" +
  "`/groupwisdom memory` shows what I've picked up · `/groupwisdom mute` quiets me · removing me from the channel stops me reading it.";

/** Said instead of the welcome when the channel is shared with another company. */
export const SLACK_SHARED_REFUSAL =
  "This channel is shared with people outside your workspace, so I won't read it: they haven't agreed to it. " +
  "Invite me to a channel that is only your own team's and I'll work there.";

export const SLACK_HELP =
  "*GroupWisdom* reads this channel and speaks only when two pieces of finished work add up to something new.\n" +
  "• `/groupwisdom memory` what I've picked up here\n" +
  "• `/groupwisdom mute` quiet until unmuted · `/groupwisdom mute today` quiet until midnight UTC\n" +
  "• `/groupwisdom unmute` back on\n" +
  "• `/groupwisdom demo` a one-minute example on made-up messages\n" +
  "The same words work as a mention: `@GroupWisdom memory`.";
