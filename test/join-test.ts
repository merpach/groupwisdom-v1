/**
 * The join: which pieces of memory a card may rest on, and what rests after.
 *
 * Two cards shipped to a real channel with the wrong second piece. An
 * onboarding measurement and then a load test were each joined to a survey
 * answer about whether the bot seemed to be running, because the scout was
 * asked to reach back into memory and did, and the editor, shown the whole
 * memory, welded in two more topics for good measure. Three things now hold
 * that down, and this drives all three through the real incremental path:
 * the pieces the scout names must resolve against memory, the editor sees
 * only what resolved, and the memory behind a card rests for a week.
 *
 * Run: GW_DB=/tmp/gw-join.db GW_WISDOM_COOLDOWN_MIN=0 npx tsx test/join-test.ts
 */
if (!process.env.GW_DB) {
  console.error("Set GW_DB to a disposable path, e.g. GW_DB=/tmp/gw-join.db");
  process.exit(1);
}
process.env.GW_WISDOM_COOLDOWN_MIN = "0"; // four batches in a row must all reach the scout

import http from "node:http";

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, extra = "") => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`); }
};

const { resolveJoin, restJoinedMemory, queueIncrementalAnalysis } = await import("../src/engine.js");
const { createGroup, addMember, addItem, addInsight, listRecentInsights, listInsights, listGateRecords, deleteGroup } =
  await import("../src/db.js");

const TESTER  = { fact: "Two of three testers said they were not sure the bot was running", by: "Prem", sources: ["a1b2c3d4"] };
const ONBOARD = { fact: "Onboarding went from nine screens to four and completion rose from 41 to 68 percent", by: "Prem", sources: ["deadbeef"] };
const PRICE   = { fact: "The annual tier is priced at 290 dollars a year", by: "Prem", sources: ["0badf00d"] };
const MONTHLY = { decision: "Ship monthly pricing before the annual tier", sources: ["cafebabe"] };
const MEM = { purpose: "Launch GroupWisdom", facts: [TESTER, ONBOARD, PRICE], decisions: [MONTHLY], open_questions: ["When does the store listing open?"] };

console.log("── naming the pieces by id ──");
let j = resolveJoin({ hypothesis: "onboarding", sources: ["deadbeef"] }, MEM);
ok(j.how === "ids" && j.facts.length === 1 && j.facts[0] === ONBOARD, "a copied source id picks exactly that fact", JSON.stringify(j));
ok(j.ids.join() === "deadbeef", "and the join carries its id");
j = resolveJoin({ hypothesis: "", sources: ["[deadbeef]", "the decision cafebabe"] }, MEM);
ok(j.facts.length === 1 && j.decisions.length === 1, "brackets and surrounding words are tolerated, and decisions resolve too", JSON.stringify(j.ids));
j = resolveJoin({ hypothesis: "", sources: ["Prem's onboarding measurement [deadbeef]"] }, MEM);
ok(j.facts[0] === ONBOARD, "an id that is not at the front of the string is still found");
j = resolveJoin({ hypothesis: "", sources: ["deadbeef-0000-4000-8000-000000000000"] }, MEM);
ok(j.facts[0] === ONBOARD, "a full uuid resolves to its prefix");
j = resolveJoin({ hypothesis: "h", sources: ["ffffffff"] }, MEM);
ok(j.how === "none" && !j.facts.length && !j.decisions.length, "THE REACH: an id the group does not hold resolves to nothing", JSON.stringify(j));
j = resolveJoin({ hypothesis: "", sources: [] }, MEM);
ok(j.how === "none", "and so does naming nothing at all");

console.log("── recovering the pieces from the wording ──");
j = resolveJoin({ hypothesis: "Prem's onboarding rewrite lifted completion from 41 to 68 percent, which bears on the annual tier at 290 dollars", sources: [] }, MEM);
ok(j.how === "text" && j.facts.includes(ONBOARD) && j.facts.includes(PRICE),
   "shared figures and words find the pieces a verdict cut off at the token ceiling lost", JSON.stringify(j.facts.map(f => f.sources)));
ok(!j.facts.includes(TESTER), "and a fact that only shares the contributor's name is not one of them");
const many = { ...MEM, facts: Array.from({ length: 5 }, (_, i) => ({ fact: `Completion rose from 41 to 68 percent in trial ${i}`, by: "Prem", sources: [`0000000${i}`] })) };
j = resolveJoin({ hypothesis: "completion rose from 41 to 68 percent", sources: [] }, many);
ok(j.facts.length === 3, "no more than three pieces, however many match", String(j.facts.length));
j = resolveJoin({ hypothesis: "The load test held forty teams at once with nothing dropped", sources: [] }, MEM);
ok(j.how === "none", "wording that touches nothing in memory resolves to nothing", JSON.stringify(j));

console.log("── the memory behind a card rests ──");
let r = restJoinedMemory(MEM, new Set(["a1b2c3d4"]));
ok(r.rested === 1 && !r.memory.facts.includes(TESTER) && r.memory.facts.includes(ONBOARD),
   "THE ATTRACTOR: the fact behind the last card is gone from the scout's view");
ok(r.memory.decisions.length === 1 && r.memory.open_questions.length === 1, "everything else stays");
r = restJoinedMemory(MEM, new Set(["cafebabe"]));
ok(r.rested === 1 && !r.memory.decisions.length, "a decision rests the same way");
r = restJoinedMemory({ ...MEM, facts: [...MEM.facts, { fact: "unsourced", by: "", sources: [] }] }, new Set(["a1b2c3d4"]));
ok(r.memory.facts.some(f => f.fact === "unsourced"), "a fact with no sources cannot be resting");
r = restJoinedMemory(MEM, new Set());
ok(r.rested === 0 && r.memory === MEM, "nothing resting, nothing changed");

console.log("── the sources a card was built on are kept ──");
const g0 = createGroup("Join sources");
const withSources = addInsight(g0.id, "tension", "T", "B", { sources: ["a1b2c3d4", "deadbeef"] });
ok(JSON.parse(withSources.sources ?? "null")?.length === 2, "sources are stored as a JSON array", String(withSources.sources));
ok(addInsight(g0.id, "pattern", "P", "B", {}).sources === null, "and null when a finding has none");
ok(listRecentInsights(g0.id, 24).length === 2, "recent insights come back within the window");
ok(listRecentInsights(g0.id, 0).length === 0, "and not outside it");
deleteGroup(g0.id);

// ── The whole path, against a model that answers the way the bad cards were made ──

type Mode = "first" | "rested" | "nothing" | "batch";
let mode: Mode = "first";
const scoutPrompts: string[] = [], editorPrompts: string[] = [], reviewPrompts: string[] = [];

const reply = (text: string) => ({
  id: "msg_fake", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001",
  content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 400, output_tokens: 120 },
});
const MEMORY_REPLY = JSON.stringify({ ...MEM, contributed: true, why: "work was delivered", handoff: null });
const CARDS = [
  { kind: "tension", title: "Testers cannot see the engine working",
    body: "Two of three testers were unsure the bot was running because nothing had been posted, so silence by design reads as absence." },
  { kind: "convergence", title: "Both measurements land on the same number",
    body: "The timing test and the interview count point the same way, and the next release can lean on either." },
];

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    const prompt: string = JSON.parse(body).messages?.[0]?.content ?? "";
    let out;
    if (prompt.includes("You maintain the working memory")) {
      out = reply(MEMORY_REPLY);
    } else if (prompt.includes("You are the scout")) {
      scoutPrompts.push(prompt);
      // "first" and "rested" both name the survey answer; the second time it is resting.
      const sources = mode === "first" || mode === "rested" ? ["a1b2c3d4"] : [];
      out = reply(JSON.stringify({ worth_drafting: true, hypothesis: mode === "batch" ? "the two measurements agree" : "h", sources, why: "" }));
    } else if (prompt.includes("You are the Wisdom engine")) {
      editorPrompts.push(prompt);
      out = reply(JSON.stringify({ new: [CARDS[Math.min(editorPrompts.length - 1, CARDS.length - 1)]], dismiss: [], why_silent: null }));
    } else if (prompt.includes("revised_title")) {
      reviewPrompts.push(prompt);
      out = reply(JSON.stringify([{ id: 0, confidence: "medium", stated_in: null, caveat: null, do_next: null, missing_voice: null,
        keep: true, drop_reason: null, revised_kind: null, revised_title: null, revised_body: null }]));
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

const g = createGroup("Join path");
const prem = addMember(g.id, "Prem", "", "prem@ex.com", null);

/** Feed one batch through the debounced path Teams and Buzz use, and wait for it. */
async function batch(m: Mode, contents: string[]) {
  mode = m;
  const items = contents.map(c => addItem(g.id, { member_id: prem.id, type: "note", title: c.slice(0, 60), content: c, source: "teams" }));
  const done = new Promise<void>(r => {
    items.forEach((it, i) => queueIncrementalAnalysis(g.id, it, i === items.length - 1 ? () => r() : undefined));
  });
  await Promise.race([done, new Promise<void>(r => setTimeout(r, 25000))]);
}
const reasons = () => listGateRecords(g.id, 20).map(x => x.reason ?? "");

console.log("── a named piece: the editor sees it and nothing else ──");
await batch("first", ["Load test: forty teams at once, every card landed inside 25 seconds, nothing dropped."]);
ok(editorPrompts.length === 1, "the editor ran", String(editorPrompts.length));
ok(editorPrompts[0]?.includes(TESTER.fact), "with the piece the scout named");
ok(!editorPrompts[0]?.includes(ONBOARD.fact) && !editorPrompts[0]?.includes(PRICE.fact),
   "THE WELD: and without the rest of memory to reach into");
ok(reviewPrompts[0]?.includes("What the candidates were built from") && reviewPrompts[0]?.includes(TESTER.fact),
   "the review is told which two pieces the finding may rest on");
const first = listInsights(g.id);
ok(first.length === 1, "one card was written", String(first.length));
const stored = JSON.parse(first[0]?.sources ?? "[]") as string[];
ok(stored.includes("a1b2c3d4") && stored.length === 2, "the card records the named piece and the contribution it joined", JSON.stringify(stored));
ok(reasons().some(x => /named by id/.test(x)), "and the gate record says how the pieces were named", reasons().join(" | "));

console.log("── the piece behind that card now rests ──");
await batch("rested", ["Onboarding rewrite shipped: nine screens down to four, completion 41 to 68 percent."]);
ok(scoutPrompts.length === 2, "the scout ran again", String(scoutPrompts.length));
ok(!scoutPrompts[1]?.includes(TESTER.fact) && scoutPrompts[1]?.includes(ONBOARD.fact),
   "THE ATTRACTOR: the survey answer is out of the scout's view and the rest of memory is not");
ok(editorPrompts.length === 1, "naming the resting piece anyway resolves to nothing, so the editor never ran", String(editorPrompts.length));
ok(reasons().some(x => /does not hold/.test(x)), "and the silence is recorded as a reach", reasons().join(" | "));

console.log("── naming nothing ──");
await batch("nothing", ["Support tickets last quarter: 22, of which 14 were setup."]);
ok(editorPrompts.length === 1, "a yes with no sources is silence", String(editorPrompts.length));
ok(reasons().some(x => /named no earlier work/.test(x)), "recorded as such", reasons().join(" | "));

console.log("── two pieces in one batch need no memory ──");
await batch("batch", [
  "Checkout prototype tested 22 percent faster to complete.",
  "In 6 of 8 interviews users preferred the one-tap prototype.",
]);
ok(editorPrompts.length === 2, "two contributions inside one batch are two pieces of work", String(editorPrompts.length));
const cards = listInsights(g.id);
ok(cards.length === 2, "and the card was written", String(cards.length));
const batchSources = JSON.parse(cards.find(c => c.kind === "convergence")?.sources ?? "[]") as string[];
ok(batchSources.length === 2 && !batchSources.includes("a1b2c3d4"), "resting on the two contributions and nothing from memory", JSON.stringify(batchSources));
ok(reasons().some(x => /joined within the batch/.test(x)), "the gate record says so", reasons().join(" | "));

deleteGroup(g.id);
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
