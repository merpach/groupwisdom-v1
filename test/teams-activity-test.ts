/**
 * Teams messages as they actually arrive, through the adapter.
 *
 * Written from a pre-handoff probe that fed realistic Teams payloads through
 * the parsing path and found two things wrong. A command typed after a mention
 * in a client that inserts a non-breaking space arrived as "&nbsp;memory" and
 * was missed, so the person asking got silence. And the private-channel guard
 * read only one of the two fields a channel's type can appear in.
 *
 * The rest pins what already worked, because it is the first thing a tester
 * touches: which messages are commands, which are work, and which are ignored.
 *
 * Run: npx tsx test/teams-activity-test.ts
 */
import { teamsCommand, shouldIngest, activityToItem, decodeEntities } from "../src/adapters/teams.js";

let pass = 0, fail = 0;
const ok = (c: boolean, n: string, extra = "") => {
  if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${extra ? " — " + extra : ""}`); }
};

const BOT = "28:7f5c7a9a-be34-489a-89c1-d9b27cfb88da";
const USER = { id: "29:1user-probe", name: "Prem Acharya", aadObjectId: "00000000-0000-0000-0000-000000000001" };
const botMention = { type: "mention", text: "<at>GroupWisdom</at>", mentioned: { id: BOT, name: "GroupWisdom" } };

function act(text: string, o: { entities?: any[]; from?: any; channelData?: any } = {}): any {
  return {
    type: "message", text,
    recipient: { id: BOT, name: "GroupWisdom" },
    from: o.from ?? USER,
    entities: o.entities ?? [],
    channelData: { team: { id: "19:team@thread.tacv2" }, channel: { id: "19:chan@thread.tacv2" }, tenant: { id: "tenant-probe" }, ...(o.channelData ?? {}) },
    conversation: { id: "19:chan@thread.tacv2;messageid=1726000000000", conversationType: "channel" },
    serviceUrl: "https://smba.trafficmanager.net/amer/",
  };
}
const cmdOf = (a: any) => { const c = teamsCommand(a); return c ? c.name : null; };

console.log("── commands addressed to the bot ──");
ok(cmdOf(act("<at>GroupWisdom</at> memory", { entities: [botMention] })) === "memory", "@mention memory");
ok(cmdOf(act("<at>GroupWisdom</at> demo", { entities: [botMention] })) === "demo", "@mention demo");
const mute = teamsCommand(act("<at>GroupWisdom</at> mute today", { entities: [botMention] }));
ok(mute?.name === "mute" && mute?.args === "today", "@mention mute today, with its argument", JSON.stringify(mute));
ok(cmdOf(act("<at>GroupWisdom</at> unmute", { entities: [botMention] })) === "unmute", "@mention unmute");
ok(cmdOf(act("<at>GroupWisdom</at>&nbsp;memory", { entities: [botMention] })) === "memory",
   "THE MISS: a non-breaking space entity after the mention no longer hides the command");
ok(cmdOf(act("<at>GroupWisdom</at> memory\n", { entities: [botMention] })) === "memory", "a trailing newline");
ok(cmdOf(act("<at>GroupWisdom</at> Memory", { entities: [botMention] })) === "memory", "capitalised");
ok(cmdOf(act("@GroupWisdom memory")) === "memory", "typed as text with no mention entity");

console.log("── work, not commands ──");
const q = act("<at>GroupWisdom</at> what do you make of the pricing thread?", { entities: [botMention] });
ok(cmdOf(q) === null && shouldIngest(q) && activityToItem(q).content === "what do you make of the pricing thread?",
   "a mention followed by something that is not a command is read as work, mention removed");
const work = act("Completion went from 41% to 68% after the rewrite.");
ok(cmdOf(work) === null && shouldIngest(work) && activityToItem(work).content === "Completion went from 41% to 68% after the rewrite.",
   "an ordinary work message is ingested unchanged");
ok(cmdOf(act("I think GroupWisdom could help with this.")) === null && shouldIngest(act("I think GroupWisdom could help with this.")),
   "naming the product in prose is not a command");
const colleague = act("<at>Sarah</at> can you check the numbers?", { entities: [{ type: "mention", text: "<at>Sarah</at>", mentioned: { id: "29:sarah", name: "Sarah" } }] });
ok(cmdOf(colleague) === null && shouldIngest(colleague), "mentioning a colleague is work, not a command");
const amp = act("R&amp;D signed off on the budget.");
ok(activityToItem(amp).content === "R&D signed off on the budget.", "entities are decoded before the engine sees the text", activityToItem(amp).content);

console.log("── ignored ──");
ok(!shouldIngest(act("<at>GroupWisdom</at>", { entities: [botMention] })) && cmdOf(act("<at>GroupWisdom</at>", { entities: [botMention] })) === null,
   "a bare mention with nothing else does nothing");
ok(!shouldIngest(act("A finding", { from: { id: BOT, name: "GroupWisdom" } })), "the bot's own post is never read back in");
ok(!shouldIngest(act("edited text", { channelData: { eventType: "editMessage" } })), "an edit is not a new contribution");

console.log("── private and shared channels, in either field ──");
ok(!shouldIngest(act("secret", { channelData: { channelType: "private" } })), "channelType private");
ok(!shouldIngest(act("secret", { channelData: { channel: { id: "19:p@thread.tacv2", membershipType: "private" } } })),
   "THE GAP: membershipType private on the channel is refused too");
ok(!shouldIngest(act("secret", { channelData: { channel: { id: "19:s@thread.tacv2", membershipType: "shared" } } })), "membershipType shared");
ok(!shouldIngest(act("secret", { channelData: { channel: { id: "19:p@thread.tacv2", membershipType: "Private" } } })), "whatever the casing");
ok(shouldIngest(act("normal", { channelData: { channel: { id: "19:c@thread.tacv2", membershipType: "standard" } } })), "a standard channel is read");
ok(shouldIngest(act("normal")), "and so is a channel that states no type at all");

console.log("── entity decoding ──");
ok(decodeEntities("a&nbsp;b") === "a b", "&nbsp;");
ok(decodeEntities("&lt;b&gt;") === "<b>", "&lt; and &gt;");
ok(decodeEntities("&amp;lt;") === "&lt;", "ampersand decoded last, so nothing is decoded twice");
ok(decodeEntities("plain text") === "plain text", "plain text is untouched");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
