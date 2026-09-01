/**
 * The hand-off gate: another member's finished work, delivered at the moment
 * someone announces they are about to need it.
 *
 * Drives the real incremental path — the one Buzz calls — against a fake
 * model, and pins the bar. A hand-off that fires on every "I'll do X" would be
 * a worse flagging system, so most of these cases are about it NOT firing:
 * the announcer's own work, an unsourced fact, a fact memory does not hold, a
 * recipient who never wrote, the same task announced twice, delivered work.
 *
 * Run: GW_DB=/tmp/gw-handoff.db npx tsx test/handoff-test.ts
 */
if (!process.env.GW_DB) {
  console.error("Set GW_DB to a disposable path, e.g. GW_DB=/tmp/gw-handoff.db");
  process.exit(1);
}

import http from "node:http";

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, extra = "") => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`); }
};

const SARAH_FACT = "The annual tier models at $290 per year assuming 4 percent monthly churn.";
const GROUP_DECISION = "Annual pricing is held until NYC retention data is in.";
const MEMORY = {
  purpose: "Ship a paid annual tier",
  facts: [{ fact: SARAH_FACT, by: "Sarah", sources: ["a1"] }],
  decisions: [{ decision: GROUP_DECISION, sources: ["b2"] }],
  open_questions: [],
};
const GOOD = {
  for: "James", task: "the pricing plan", headline: "Sarah already priced the annual tier",
  facts: [
    { fact: SARAH_FACT, by: "Sarah", sources: ["a1"] },
    { fact: GROUP_DECISION, by: "the group", sources: ["b2"] },
  ],
};

/** What the memory update returns for its hand-off field, per scenario. */
let handoff: unknown = null;
let contributed = false;
let scoutCalls = 0;

const reply = (text: string) => ({
  id: "msg_fake", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001",
  content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 300, output_tokens: 200 },
});

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    const prompt: string = JSON.parse(body).messages?.[0]?.content ?? "";
    let out;
    if (prompt.includes("You maintain the working memory")) {
      out = reply(JSON.stringify({ ...MEMORY, contributed, why: contributed ? "a draft was delivered" : "announced work, delivered none", handoff }));
    } else if (prompt.includes("You are the scout")) {
      scoutCalls++;
      out = reply('{"worth_drafting":false,"hypothesis":"","sources":[],"why":"nothing to join"}');
    } else {
      out = reply('{"overlaps":[],"overlap":null}');
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
  });
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
process.env.ANTHROPIC_API_KEY = "sk-ant-fake-for-test";

const { createGroup, addMember, addItem, deleteGroup, listInsights, db } = await import("../src/db.js");
const { queueIncrementalAnalysis } = await import("../src/engine.js");

const gates = (groupId: string) =>
  db.prepare("SELECT stage, verdict, reason, title FROM gate_records WHERE group_id = ? ORDER BY rowid")
    .all(groupId) as Array<{ stage: string; verdict: string; reason: string | null; title: string | null }>;
const handoffs = (groupId: string) => listInsights(groupId).filter(i => i.kind === "handoff");

/** James announces the pricing plan in #general; wait for the batch to settle. */
async function announce(groupId: string, author = "James", text = "I'll write the pricing plan this week.") {
  const m = addMember(groupId, author, "", `${author.toLowerCase()}@ex.com`, null);
  const item = addItem(groupId, { member_id: m.id, type: "note", title: text.slice(0, 60), content: text, source: "buzz", channel: "chan-general" });
  await Promise.race([
    new Promise<void>(r => queueIncrementalAnalysis(groupId, item, () => r())),
    new Promise<void>(r => setTimeout(r, 20000)),
  ]);
}
function fresh(name: string) {
  const g = createGroup(name);
  addMember(g.id, "Sarah", "", "sarah@ex.com", null);
  return g.id;
}
const groups: string[] = [];

console.log("── the hand-off that should fire ──");
handoff = GOOD; scoutCalls = 0;
const g1 = fresh("Hand-off fires"); groups.push(g1);
await announce(g1);
const h1 = handoffs(g1);
ok(h1.length === 1, "THE POINT: announcing work produced a hand-off", `got ${h1.length}`);
ok(h1[0]?.title === GOOD.headline, "the headline is the card's title", h1[0]?.title);
ok(/\$290/.test(h1[0]?.body ?? "") && /\(Sarah\)/.test(h1[0]?.body ?? ""), "the body carries Sarah's number, with her name on it", h1[0]?.body);
ok(/\(the group\)/.test(h1[0]?.body ?? ""), "and the standing decision", h1[0]?.body);
ok(h1[0]?.channel === "chan-general", "drawn for the channel it will be posted into", String(h1[0]?.channel));
ok(h1[0]?.confidence === "high", "a relay of recorded facts is marked high", String(h1[0]?.confidence));
ok(h1[0]?.status === "acknowledged", "live, like every incremental card");
const spoke = gates(g1).find(r => r.stage === "handoff" && r.verdict === "spoken");
ok(!!spoke && /for James, before the pricing plan/.test(spoke.reason ?? ""), "the gate record says who, and before what", spoke?.reason ?? "");
ok(scoutCalls === 0, "and the scout never ran: no join was attempted", `scout calls: ${scoutCalls}`);

console.log("── the same task, announced again ──");
await announce(g1, "James", "Starting the pricing plan now.");
ok(handoffs(g1).length === 1, "no second card for the same work inside the window");
ok(gates(g1).some(r => r.stage === "handoff" && r.verdict === "silent" && /already handed off/.test(r.reason ?? "")),
   "and the reason is recorded", gates(g1).map(r => r.reason).join(" | "));

console.log("── the bar: each way a proposal must be refused ──");
const refuse = async (name: string, proposal: unknown, expect: RegExp) => {
  handoff = proposal;
  const g = fresh(name); groups.push(g);
  await announce(g);
  const rec = gates(g).find(r => r.stage === "handoff" && r.verdict === "silent");
  ok(handoffs(g).length === 0 && !!rec && expect.test(rec.reason ?? ""), name, rec?.reason ?? "no handoff record");
};
await refuse("their own work is not handed back", { ...GOOD, facts: [{ fact: SARAH_FACT, by: "James", sources: ["a1"] }] }, /their own work/);
await refuse("an unsourced fact is not handed over", { ...GOOD, facts: [{ fact: SARAH_FACT, by: "Sarah", sources: [] }] }, /unsourced/);
await refuse("a fact memory does not hold is not handed over", { ...GOOD, facts: [{ fact: "Churn on the monthly tier dropped to 2 percent after the redesign.", by: "Sarah", sources: ["z9"] }] }, /not in memory/);
await refuse("a recipient who never wrote is invented", { ...GOOD, for: "Priya" }, /did not write in this batch/);

console.log("── what must not change ──");
handoff = null;
const g2 = fresh("A plain question"); groups.push(g2);
await announce(g2, "James", "Should we price annually at all?");
ok(handoffs(g2).length === 0 && !gates(g2).some(r => r.stage === "handoff"), "no hand-off proposed, no hand-off record");
ok(gates(g2).some(r => r.stage === "scan" && r.verdict === "silent" && /No new contribution/.test(r.reason ?? "")), "the ordinary silence is unchanged");

handoff = GOOD; contributed = true; scoutCalls = 0;
const g3 = fresh("Delivered work"); groups.push(g3);
await announce(g3, "James", "Here is the pricing plan draft: annual at $290, monthly at $29.");
ok(handoffs(g3).length === 0, "delivered work never becomes a hand-off, even with one proposed");
ok(scoutCalls > 0, "it takes the join path instead", `scout calls: ${scoutCalls}`);

for (const g of groups) deleteGroup(g);
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
