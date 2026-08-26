/**
 * A topic leaving working memory should leave a trace.
 *
 * The review ran a second topic alongside the first, watched it vanish from
 * /memory entirely, and found nothing in /gate-records saying so.
 */
// Refuses to run against a real database. Every run is a fresh throwaway.
if (!process.env.GW_DB) {
  console.error("Set GW_DB to a disposable path, e.g. GW_DB=/tmp/gw-test.db");
  process.exit(1);
}

import { factsDropped } from "../src/engine.js";

let pass = 0, fail = 0;
const eq = (g: unknown, w: unknown, n: string) => {
  if (JSON.stringify(g) === JSON.stringify(w)) { pass++; console.log(`  ok  ${n}`); }
  else { fail++; console.log(`FAIL  ${n}\n      got:  ${JSON.stringify(g)}\n      want: ${JSON.stringify(w)}`); }
};
const f = (fact: string) => ({ fact, by: "x", sources: [] });
const names = (r: ReturnType<typeof factsDropped>) => r.map(x => x.fact);

// The review's own scenario: checkout crowds out the mill-closure thread.
const checkout = f("The checkout redesign tested 22% faster because cards are saved by default");
const mill     = f("Dana dated the mill closure to March 1974 from the archive scan");
const layoffs  = f("Leo's oral history has three residents describing the same winter layoffs");

eq(names(factsDropped([checkout, mill, layoffs], [checkout])), [mill.fact, layoffs.fact],
  "THE EVICTION: both facts from the minority topic are reported as dropped");

eq(factsDropped([checkout, mill], [checkout, mill]), [], "an unchanged memory reports nothing");

// The reason this compares meaning rather than strings.
eq(factsDropped(
  [f("The checkout redesign tested 22% faster because cards are saved by default")],
  [f("Checkout redesign measured 22% faster, driven by cards being saved by default")]), [],
  "THE FALSE ALARM: a rephrased fact still counts as held, or every update reports total loss");

eq(names(factsDropped([checkout, mill], [checkout, f("Priya owns the payment migration")])), [mill.fact],
  "a fact replaced by an unrelated one is a drop");

eq(factsDropped([], [checkout]), [], "a first-ever memory drops nothing");
eq(names(factsDropped([mill], [])), [mill.fact], "emptying memory reports everything");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
