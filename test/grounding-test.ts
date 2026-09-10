/**
 * Grounding: can a reader check this card against what was written?
 *
 * Three cards shipped to a real channel and all three misattributed something.
 * One invented a four-person team to make a division work; one concluded a
 * $290 price did not cover $4.25 per seat, which only holds above six seats.
 * The machinery meant to catch that existed and never ran: groundConfidence
 * returned early unless confidence was "high", and a joined finding is
 * "medium" by construction, because nobody states a join outright.
 *
 * Run: npx tsx test/grounding-test.ts
 */
import { groundConfidence, ungroundedFigures, stripJoiningSemicolons, fragmentCount } from "../src/engine.js";

let pass = 0, fail = 0;
const ok = (c: boolean, n: string, extra = "") => {
  if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${extra ? " — " + extra : ""}`); }
};

const SOURCE = `Shipped the onboarding rewrite: nine screens down to four. Completion went from 41% to 68%.
Last quarter's support tickets, all 22 of them. Fourteen were people stuck partway through setup.
Priced the annual tier at $290 a year, assuming 4% monthly churn.
Costs run about $4.25 per seat per month, never past $7.`;

console.log("── the check that never ran ──");
const cooked = groundConfidence("medium", "a four-person team paying $24 per seat", SOURCE);
ok(cooked.downgraded && cooked.confidence === "low",
   "THE GAP: a medium finding anchored to words nobody wrote is now caught", JSON.stringify(cooked));
ok(/nobody wrote/.test(cooked.why ?? ""), "and says so", cooked.why ?? "");
const honest = groundConfidence("medium", "Fourteen were people stuck partway through setup", SOURCE);
ok(!honest.downgraded && honest.confidence === "medium", "a real quote passes untouched", JSON.stringify(honest));

console.log("── what must not change ──");
ok(groundConfidence("high", "Completion went from 41% to 68%", SOURCE).confidence === "high",
   "a high finding with a real quote stays high");
ok(groundConfidence("high", null, SOURCE).confidence === "medium",
   "high with no quote still drops to medium");
ok(groundConfidence("medium", null, SOURCE).confidence === "medium",
   "medium with no quote is left alone, which is the ordinary case");
ok(groundConfidence("medium", "short", SOURCE).confidence === "medium",
   "a fragment too short to match is not treated as a lie");

console.log("── numbers the reader cannot trace ──");
ok(ungroundedFigures("A monthly price of $24 per seat for a four-person team.", SOURCE).includes("24"),
   "THE BUG: $24 appears in no message and is flagged");
ok(ungroundedFigures("Completion went from 41% to 68% across 22 tickets.", SOURCE).length === 0,
   "figures lifted straight from the messages are clean",
   ungroundedFigures("Completion went from 41% to 68% across 22 tickets.", SOURCE).join(","));
ok(ungroundedFigures("Costs run $4.25 per seat, never past $7.", SOURCE).length === 0,
   "decimals and small figures match too");
ok(ungroundedFigures("Seven of the tickets were billing.", SOURCE).length === 0,
   "a number written as a word is not a figure claim");
// 22 minus 14 minus the one integration bug. Correct, and traceable to no
// single message, which is exactly why this records rather than suppresses.
ok(ungroundedFigures("That leaves 8 tickets in the other categories.", SOURCE).includes("8"),
   "but a derived digit is surfaced, which is why this records rather than blocks",
   ungroundedFigures("That leaves 8 tickets in the other categories.", SOURCE).join(","));

console.log("── prose the prompt could not enforce ──");
// Both prompts ban these and both shipped anyway across six live runs, so they
// are handled here instead, the same way the em dash already is.
ok(stripJoiningSemicolons("Two could approve $15 alone; one could expense under $10.")
   === "Two could approve $15 alone. One could expense under $10.",
   "a semicolon joining two statements becomes a full stop");
ok(stripJoiningSemicolons("Costs run $4.25 per seat.") === "Costs run $4.25 per seat.",
   "a body without one is untouched");
ok(fragmentCount("When he spoke with three leads. At an agency, a SaaS company, and a research group.") >= 2,
   "a list punctuated as prose is counted as fragments");
ok(fragmentCount("Prem found the engine runs at $4.25 per seat. Three leads named $15 as their limit.") === 0,
   "real sentences are not");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
