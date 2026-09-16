/**
 * The model question, answered on real inputs rather than argued.
 *
 * Replays the messages behind the cards that shipped to a real Teams channel
 * through the real incremental path against the real API, under whatever
 * model and sampling the environment names, and prints every card, every
 * gate verdict and the spend. Run it once per configuration and read the
 * cards side by side. On 15 September 2026 this is how Haiku was found to
 * make reasoning errors in five of eight cards on these inputs and Opus in
 * none of six, and how the units rule was checked before it shipped.
 *
 *   GW_DB=/tmp/gw-trial.db GW_WISDOM_COOLDOWN_MIN=0 \
 *   [GW_JUDGMENT_MODEL=claude-opus-4-8] [GW_JUDGMENT_THINKING=1] \
 *   [GW_ENGINE_TEMPERATURE=0] [TRIAL_SCENARIOS=pricing,load] \
 *   npx tsx --env-file=.env tools/model-trial.ts <label> [repeats]
 *
 * Costs real money: a full run of all three scenarios is about $0.03 on
 * Haiku and $0.11 with Opus on the judgment stages, per repeat.
 */
import { readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.GW_DB) {
  console.error("Set GW_DB to a disposable path, e.g. GW_DB=/tmp/gw-trial.db");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Needs a real ANTHROPIC_API_KEY: run with --env-file=.env");
  process.exit(1);
}

const label = process.argv[2] ?? "unlabelled";
const reps = Number(process.argv[3] ?? 2);
const inputs = JSON.parse(readFileSync(new URL("./model-trial-inputs.json", import.meta.url), "utf8")) as Record<string, string>;
const resultsFile = join(tmpdir(), "gw-model-trial.jsonl");

const { createGroup, addMember, addItem, listInsights, listGateRecords, deleteGroup, db } = await import("../src/db.js");
const { queueIncrementalAnalysis } = await import("../src/engine.js");

// Each scenario is the order the real channel saw the messages, one batch each.
const SCENARIOS: Record<string, string[]> = {
  pricing:    ["annual", "costs", "leads"],
  onboarding: ["testers", "onboarding", "tickets"],
  load:       ["testers", "annual", "load", "wave"],
};

type StepResult = { step: string; cards: any[]; gates: string[]; ms: number };

async function run(scenario: string, rep: number) {
  const g = createGroup(`trial ${label} ${scenario} #${rep}`);
  const m = addMember(g.id, "Prem Acharya", "teams");
  const steps: StepResult[] = [];
  let seen = 0;
  for (const key of SCENARIOS[scenario]) {
    const text = inputs[key];
    const t0 = Date.now();
    const item = addItem(g.id, { member_id: m.id, type: "note", title: text.slice(0, 80), content: text, source: "teams" });
    const gatesBefore = listGateRecords(g.id, 100).length;
    await Promise.race([
      new Promise<void>(r => queueIncrementalAnalysis(g.id, item, () => r())),
      new Promise<void>(r => setTimeout(r, 180_000)),
    ]);
    const all = listInsights(g.id);
    const fresh = all.slice(0, all.length - seen);
    seen = all.length;
    const gatesNow = listGateRecords(g.id, 100);
    const gates = gatesNow.slice(0, gatesNow.length - gatesBefore)
      .map(x => `${x.stage}/${x.verdict}: ${x.reason ?? x.title ?? ""}`);
    steps.push({
      step: key,
      cards: fresh.map(c => ({ kind: c.kind, confidence: c.confidence, title: c.title, body: c.body, stated_in: c.stated_in, caveat: c.caveat, do_next: c.do_next, sources: c.sources })),
      gates, ms: Date.now() - t0,
    });
  }
  const usage = db.prepare(
    "SELECT purpose, model, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cost_usd) AS c FROM usage_events WHERE group_id = ? GROUP BY purpose, model"
  ).all(g.id) as Array<{ purpose: string; model: string; i: number; o: number; c: number }>;
  const cost = usage.reduce((s, u) => s + u.c, 0);
  deleteGroup(g.id);
  return { label, scenario, rep, steps, usage, cost };
}

const chosen = (process.env.TRIAL_SCENARIOS ?? Object.keys(SCENARIOS).join(",")).split(",").filter(s => s in SCENARIOS);
const jobs: Promise<any>[] = [];
for (const scenario of chosen) for (let rep = 1; rep <= reps; rep++) jobs.push(run(scenario, rep));
const results = await Promise.all(jobs);

for (const r of results) {
  appendFileSync(resultsFile, JSON.stringify(r) + "\n");
  console.log(`\n═══ ${r.label} · ${r.scenario} #${r.rep} · $${r.cost.toFixed(4)} ═══`);
  for (const s of r.steps) {
    console.log(`  ▸ ${s.step} (${(s.ms / 1000).toFixed(0)}s)`);
    for (const gt of s.gates) console.log(`      gate  ${gt.slice(0, 160)}`);
    for (const c of s.cards) {
      console.log(`      CARD  [${c.kind}/${c.confidence}] ${c.title}`);
      console.log(`            ${c.body}`);
      if (c.stated_in) console.log(`            stated_in: "${c.stated_in.slice(0, 120)}"`);
      if (c.do_next) console.log(`            do_next: ${c.do_next}`);
    }
  }
}
const total = results.reduce((s, r) => s + r.cost, 0);
const cards = results.reduce((s, r) => s + r.steps.reduce((t: number, x: StepResult) => t + x.cards.length, 0), 0);
console.log(`\n${label}: ${results.length} runs, ${cards} cards, $${total.toFixed(4)} total (details appended to ${resultsFile})`);
process.exit(0);
