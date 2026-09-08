/**
 * "@GroupWisdom memory" in Teams, and the promises the manifest makes.
 *
 * The store listing told Microsoft the command exists while the bot answered
 * "not available in Teams yet". A reviewer would have hit that in a minute.
 * The reply is a pure function now, ported from Buzz, so both surfaces give
 * the same answer — and the drift guards below fail the build if the manifest
 * ever again promises a command the hook does not handle, or if the zip a
 * company downloads is not the manifest in the repo.
 *
 * Run: npx tsx test/teams-memory-test.ts
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { formatMemoryReply } from "../src/adapters/teams.js";

let pass = 0, fail = 0;
const ok = (c: boolean, n: string, extra = "") => {
  if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${extra ? " — " + extra : ""}`); }
};

const items = [
  { id: "aaaa1111-0000", content: "The annual tier models at $290 per year assuming 4 percent monthly churn." },
  { id: "bbbb2222-0000", content: "We should hold pricing until NYC retention is in, here is why in detail and at length so it truncates." },
];
const mem = {
  facts: [
    { fact: "Annual tier priced at $290/yr", by: "Sarah", sources: ["aaaa1111"] },
    { fact: "Pricing on hold until NYC retention data", by: "7dcbf07d9287abcd", sources: ["bbbb2222"] },
  ],
  decisions: [{ decision: "Hold annual pricing until NYC retention data is in." }],
  open_questions: ["Should the monthly tier change too?"],
  active_wisdom: [{}, {}],
};

console.log("── the reply ──");
const r = formatMemoryReply(mem, items, { scoped: false, hidden: 0, muted: false });
ok(r.startsWith("Here is what I know so far."), "opens with the unscoped line");
ok(/• Pricing on hold[^\n]*— from “We should hold pricing/.test(r), "a fact quotes the message it came from");
ok(!/7dcbf07d/.test(r), "a contributor we only know as an id is left off, not printed", r);
ok(/\(Sarah\)/.test(r), "a named contributor is credited");
ok(/What you have decided:\n• Hold annual pricing/.test(r), "decisions are listed");
ok(/Still open:\n• Should the monthly tier/.test(r), "open questions are listed");
ok(/I have shared 2 findings/.test(r), "the spoken count appears when unscoped");

console.log("── scoping ──");
const s = formatMemoryReply(mem, items, { scoped: true, hidden: 3, muted: true });
ok(s.startsWith("Here is what I know from this channel."), "scoped answers say so");
ok(!/I have shared/.test(s), "and never quote the team-wide count, which would overstate it");
ok(/notes from other channels here/.test(s), "withheld notes are acknowledged, not leaked");
ok(/I am muted in this channel/.test(s), "a muted channel is told how to unmute");

console.log("── the manifest keeps its promises ──");
const manifest = JSON.parse(readFileSync("teams-app/manifest.json", "utf8"));
const promised: string[] = (manifest.bots?.[0]?.commandLists ?? []).flatMap((l: any) => l.commands.map((c: any) => c.title));
const hook = readFileSync("src/teams-hook.ts", "utf8");
const handled = promised.filter(t => new RegExp(`cmd\\.name === "${t}"`).test(hook));
ok(promised.length >= 4, "the manifest lists the commands", promised.join(","));
ok(handled.length === promised.length, "THE DRIFT GUARD: every promised command is handled by the hook",
   `promised ${promised.join(",")} / handled ${handled.join(",")}`);
ok(/@GroupWisdom memory/.test(manifest.description.full) && handled.includes("memory"),
   "the store description's 'memory' promise is now true");
ok(!/not available in Teams yet/.test(hook), "the old stub is gone");

console.log("── the package a company downloads ──");
const zipManifest = execSync("unzip -p public/groupwisdom-teams.zip manifest.json", { encoding: "utf8" });
ok(zipManifest === readFileSync("teams-app/manifest.json", "utf8"), "public zip carries the exact manifest in the repo");
const entries = execSync("unzip -Z1 public/groupwisdom-teams.zip", { encoding: "utf8" }).trim().split("\n").sort();
ok(JSON.stringify(entries) === JSON.stringify(["color.png", "manifest.json", "outline.png"]), "and exactly the three files Teams expects at the root", entries.join(","));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
