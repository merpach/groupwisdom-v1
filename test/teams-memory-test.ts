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
import { formatMemoryReply, pairingCard, teamsAdaptiveCardActivity } from "../src/adapters/teams.js";

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

console.log("── the pairing card ──");
const card = pairingCard("AB3K7Q", "https://groupwisdom.ai/teams?code=AB3K7Q");
ok(card.type === "AdaptiveCard" && card.version === "1.4", "a valid Adaptive Card envelope");
ok(JSON.stringify(card.body).includes("AB3K7Q"), "the code is still shown, for anyone who would rather type it");
const open = card.actions.find((a: any) => a.type === "Action.OpenUrl") as any;
ok(!!open && open.url === "https://groupwisdom.ai/teams?code=AB3K7Q", "THE POINT: the button carries the code in the link");
const act = teamsAdaptiveCardActivity("fallback", card, "msg1") as any;
ok(act.attachments?.[0]?.contentType === "application/vnd.microsoft.card.adaptive" && act.replyToId === "msg1",
   "wrapped as a card attachment, threaded under the install message");
ok(!/await say\(ref, pairingMessage\(/.test(hook) && /sayCard\(ref, pairingMessage\(pending\.code\), pairingCard\(/.test(hook),
   "THE DRIFT GUARD: both offer sites send the card, not the bare text");
ok(readFileSync("public/teams.html", "utf8").includes('URLSearchParams(location.search).get("code")'), "and the connect page reads the code from the link");

console.log("── the setup page links somewhere useful ──");
const page = readFileSync("public/teams.html", "utf8");
ok(page.includes("https://admin.teams.microsoft.com/policies/manage-apps"),
   "the recommended route links straight to the admin centre page that does it");
ok(page.includes("https://admin.teams.microsoft.com/policies/app-setup"),
   "and the 'option is missing' hint links to the setting that fixes it");
ok(/id="copyNote"/.test(page) && /groupwisdom-teams\.zip/.test(page),
   "a ready-made note for the admin, carrying the package URL");
// The install deep link needs the per-tenant ORG CATALOG id, not our manifest
// id, so it would fail in exactly the route we recommend. Better absent.
ok(!/teams\.microsoft\.com\/l\/app\//.test(page),
   "THE TRAP: no app-install deep link, which cannot work before the app is in the tenant");

console.log("── what the admin centre demands ──");
// The upload was rejected with: "Applications with manifest version 1.25 or
// higher that support the 'team' scope must include the 'supportsChannelFeatures'
// property." Only "tier1" is allowed, and it is the whole gate on the route we
// recommend most, so it is pinned here rather than left to be dropped again.
ok(manifest.supportsChannelFeatures === "tier1",
   "THE BLOCKER: v1.25 + team scope declares supportsChannelFeatures tier1",
   String(manifest.supportsChannelFeatures));
// The separate opt-in for non-standard channels. Absent on purpose: standard
// channels come with team scope, and the store description promises we never
// read a private one. Adding this would make that a lie.
ok(manifest.supportedChannelTypes === undefined,
   "and NOT supportedChannelTypes, so 'never private channels' stays true",
   JSON.stringify(manifest.supportedChannelTypes));
ok(/never private channels/i.test(manifest.description.full),
   "which is what the store description says");
ok(manifest.version !== "0.1.0",
   "the version moved, so an existing install can take the update", manifest.version);

console.log("── the package a company downloads ──");
const zipManifest = execSync("unzip -p public/groupwisdom-teams.zip manifest.json", { encoding: "utf8" });
ok(zipManifest === readFileSync("teams-app/manifest.json", "utf8"), "public zip carries the exact manifest in the repo");
const entries = execSync("unzip -Z1 public/groupwisdom-teams.zip", { encoding: "utf8" }).trim().split("\n").sort();
ok(JSON.stringify(entries) === JSON.stringify(["color.png", "manifest.json", "outline.png"]), "and exactly the three files Teams expects at the root", entries.join(","));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
