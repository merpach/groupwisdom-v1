/**
 * Holding a community's knowledge to the channel that can see it.
 *
 * Memory is built across a whole community on purpose: noticing that two people
 * in two rooms are building the same thing is the product. But a channel someone
 * is not in is not theirs to read, so anything we *say* into a channel has to be
 * built only from what that channel can see.
 *
 * Shared by the engine (which filters what a scan may draw on) and the Buzz
 * adapter (which filters what `@wisdom memory` recites), so both sides trace
 * provenance the same way instead of each inventing a rule.
 *
 * Deliberately dependency-free — the adapter is meant to run on its own.
 */

/**
 * Set GW_CHANNEL_SCOPE=0 to turn scoping off, for a community whose channels all
 * share one membership. Nothing is hidden from anyone there, and scoping costs
 * real value: a finding can no longer combine two channels. On by default,
 * because the safe direction is the one you can undo after checking.
 */
export const channelScopeEnabled = () => process.env.GW_CHANNEL_SCOPE !== "0";

/**
 * Item ids reach us as short 8-character prefixes, and a model asked to cite
 * them may return "[a1b2c3d4]" or the full uuid. Reduce anything to the prefix.
 */
export const normalizeSourceId = (s: unknown) =>
  String(s ?? "").replace(/[^0-9a-f]/gi, "").slice(0, 8).toLowerCase();

/** Anything carrying a channel: an item, or wisdom we already spoke. */
type Placed = { channel?: string | null };

/**
 * Can a scan running for `channel` draw on this?
 *
 * Untagged counts as visible. Untagged means "no channel", not "another
 * channel": it is either an item that arrived through the API, which belongs to
 * whoever owns the project, or one ingested before we recorded channels at all.
 * Excluding it would stop the engine dead on every existing community and on
 * every API-only project, which is a worse failure than the exposure it closes,
 * and the raw messages age out under retention within 30 days anyway.
 *
 * `@wisdom memory` takes the stricter line and withholds untagged, because a
 * thinner answer costs nothing. Two rules, each set by what breaks if it is wrong.
 */
export const visibleTo = (channel: string | null, x: Placed) =>
  !channel || x.channel == null || x.channel === channel;

/**
 * Short ids of the items a fact may be traced to and still count as in scope.
 *
 * Strict narrows this to items actually tagged with the channel: untagged no
 * longer counts, so a fact resting only on untagged content is not claimed by
 * any channel.
 */
export function visibleShortIds(
  channel: string | null,
  items: Array<{ id?: string; channel?: string | null }>,
  opts: { strict?: boolean } = {},
): Set<string> {
  const out = new Set<string>();
  for (const it of items) {
    if (!it?.id) continue;
    const ok = opts.strict ? (!!channel && it.channel === channel) : visibleTo(channel, it);
    if (ok) out.add(normalizeSourceId(it.id));
  }
  return out;
}

/** Facts and decisions carry the short ids of the messages they came from. */
export type ScopableMemory = {
  facts?: Array<{ sources?: string[]; [k: string]: any }>;
  decisions?: Array<{ sources?: string[]; [k: string]: any }>;
  open_questions?: string[];
  [k: string]: any;
};

/**
 * Keep only what a scan for `channel` may draw on, tracing each fact through
 * its sources back to the messages it came from. A fact whose sources are all
 * in another channel is dropped; one with no traceable source at all is kept
 * only when `strict` is off.
 *
 * `strict` is the difference between the two callers. The engine runs
 * non-strict, so an untraceable fact still informs a card. The memory command
 * runs strict, so it recites nothing it cannot place.
 */
export function scopeMemory(
  mem: ScopableMemory,
  channel: string | null,
  items: Array<{ id?: string; channel?: string | null }>,
  opts: { strict?: boolean } = {},
): { memory: ScopableMemory; hidden: number } {
  const strict = opts.strict ?? false;
  const visible = visibleShortIds(channel, items, { strict });

  const held = new Set(items.filter(i => i?.id).map(i => normalizeSourceId(i.id!)));

  const keep = (sources?: string[]) => {
    const ids = (sources ?? []).map(normalizeSourceId).filter(Boolean);
    // Traceable to a message this channel may see: in scope.
    if (ids.some(id => visible.has(id))) return true;
    // Names a message we hold that this channel may not see: another channel's
    // work, and never in scope however lenient we are being.
    if (ids.some(id => held.has(id))) return false;
    // Places nowhere at all, either because it cites nothing or because it cites
    // messages we no longer hold. Strict withholds it; the engine lets it through,
    // since a fact about the group is likelier than a leak and dropping every
    // one of them would empty the scan.
    return !strict;
  };

  const facts = (mem.facts ?? []).filter(f => keep(f?.sources));
  const decisions = (mem.decisions ?? []).filter(d => keep(d?.sources));
  const questions = strict ? [] : (mem.open_questions ?? []);
  const hidden =
    (mem.facts?.length ?? 0) - facts.length +
    (mem.decisions?.length ?? 0) - decisions.length +
    (mem.open_questions?.length ?? 0) - questions.length;

  return { memory: { ...mem, facts, decisions, open_questions: questions }, hidden };
}
