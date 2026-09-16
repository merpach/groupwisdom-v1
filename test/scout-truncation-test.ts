/**
 * The batch that used to die: a scout verdict cut off at the token ceiling.
 *
 * Production recorded "Engine hiccup: scout failed: Unexpected end of JSON
 * input" and dropped the whole batch. The reply only grows long enough to
 * truncate when the scout has found something and has to name both pieces of
 * work, so the engine went silent at exactly the moments it had something to
 * say. This drives the real incremental path — the one Buzz calls — against a
 * model that truncates the scout the way production did.
 *
 * Run: GW_DB=/tmp/gw-scout.db npx tsx test/scout-truncation-test.ts
 */
if (!process.env.GW_DB) {
  console.error("Set GW_DB to a disposable path, e.g. GW_DB=/tmp/gw-scout.db");
  process.exit(1);
}

import http from "node:http";

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, extra = "") => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`); }
};

let truncateScout = true;
let scoutCalls = 0, editorCalls = 0;

const reply = (text: string, stop = "end_turn") => ({
  id: "msg_fake", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001",
  content: [{ type: "text", text }],
  stop_reason: stop, stop_sequence: null,
  usage: { input_tokens: 400, output_tokens: 120 },
});

const MEMORY = JSON.stringify({
  purpose: "Ship a faster checkout",
  facts: [
    { text: "Checkout prototype tested 22% faster to complete", by: "Sarah", items: ["1"] },
    { text: "6 of 8 interviewees preferred the one-tap payment prototype", by: "James", items: ["2"] },
  ],
  decisions: [], open_questions: [],
  contributed: true, why: "two contributors each delivered a measurement",
});

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    const prompt: string = JSON.parse(body).messages?.[0]?.content ?? "";
    let out;
    if (prompt.includes("You are the scout")) {
      scoutCalls++;
      out = truncateScout
        // Cut off mid-hypothesis with no closing brace — what production hit.
        ? reply('{"worth_drafting":true,"hypothesis":"Sarah\'s 22% faster checkout timing joins James\'s interview finding that 6 of 8 preferred one-tap', "max_tokens")
        : reply('{"worth_drafting":true,"hypothesis":"Sarah\'s timing joins James\'s interviews","sources":["1","2"],"why":"two separate measurements"}');
    } else if (prompt.includes("You are the Wisdom engine")) {
      editorCalls++;
      out = reply(JSON.stringify({
        new: [{ kind: "convergence", title: "Two measurements point the same way",
                body: "The prototype timing and the interview preference are the same signal from different rooms." }],
        dismiss: [], why_silent: null,
      }));
    } else if (prompt.includes("You maintain the working memory")) {
      out = reply(MEMORY);
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

const errorGates = (groupId: string) =>
  (db.prepare("SELECT reason FROM gate_records WHERE group_id = ? AND verdict = 'error'")
     .all(groupId) as Array<{ reason: string }>).map(r => r.reason);

/** Feed two contributions through the debounced path Buzz uses, and wait. */
async function runBatch(name: string) {
  const g = createGroup(name);
  const sarah = addMember(g.id, "Sarah", "", "sarah@ex.com", null);
  const james = addMember(g.id, "James", "", "james@ex.com", null);
  const a = addItem(g.id, { member_id: sarah.id, type: "note", title: "Checkout timing", content: "Checkout prototype tested 22% faster to complete", source: "teams" });
  const b = addItem(g.id, { member_id: james.id, type: "note", title: "Interview preference", content: "In 6 of 8 interviews users preferred the one-tap payment prototype", source: "teams" });
  const done = new Promise<void>(r => {
    queueIncrementalAnalysis(g.id, a);
    queueIncrementalAnalysis(g.id, b, () => r());
  });
  await Promise.race([done, new Promise<void>(r => setTimeout(r, 25000))]);
  return g.id;
}

console.log("── a scout reply cut off at the token ceiling ──");
const g1 = await runBatch("Scout truncation");
ok(scoutCalls > 0, "the scout ran", `calls: ${scoutCalls}`);
const errs = errorGates(g1);
ok(!errs.some(r => /Unexpected end of JSON input/.test(r)),
   "THE BUG: no 'Unexpected end of JSON input' hiccup", errs.join(" | "));
ok(!errs.some(r => /scout failed/.test(r)), "the batch is not discarded as a scout failure", errs.join(" | "));
ok(editorCalls > 0, "the truncated verdict still carried the engine through to the editor",
   `editor calls: ${editorCalls}`);
ok(listInsights(g1).length > 0, "and the finding that used to be lost was actually written");

console.log("── an untruncated reply still behaves ──");
truncateScout = true; // keep the hard case as the default
const before = { scout: scoutCalls, editor: editorCalls };
truncateScout = false;
const g2 = await runBatch("Scout normal");
ok(errorGates(g2).length === 0, "a complete reply records no error", errorGates(g2).join(" | "));
ok(scoutCalls > before.scout, "the scout ran again on the second batch");
ok(listInsights(g2).length > 0, "and it produced a finding");

deleteGroup(g1); deleteGroup(g2);
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
