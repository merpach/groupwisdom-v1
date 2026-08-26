/**
 * The scout's reply, cut off at the token ceiling.
 *
 * A reply that stops mid-JSON has no closing brace, so slicing to the last "}"
 * produced an empty string and JSON.parse died with "Unexpected end of JSON
 * input" — losing the batch. Truncation only happens when the model has a lot
 * to say, which for the scout means it found something, so this failed at
 * exactly the moments that mattered. These cases pin the recovery.
 *
 * Run: node test/json-repair-test.mjs
 */
import { closeOpenJson, parseModelJson } from "../dist/text-util.js";

let pass = 0, fail = 0;
const eq = (got, want, name) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}\n      got:  ${g}\n      want: ${w}`); }
};
const throws = (fn, name) => {
  try { fn(); fail++; console.log(`FAIL  ${name} — expected a throw`); }
  catch { pass++; console.log(`  ok  ${name}`); }
};

console.log("── the failure from production ──");
// Verbatim shape of a scout verdict cut off while naming the second piece of work.
const cut = '{"worth_drafting":true,"hypothesis":"Prem\'s request for a Hinge-style plan joins Marketer';
eq(JSON.parse(closeOpenJson(cut)),
   { worth_drafting: true, hypothesis: "Prem's request for a Hinge-style plan joins Marketer" },
   "a verdict cut mid-string keeps worth_drafting and the partial hypothesis");
eq(parseModelJson(cut, "scout").worth_drafting, true,
   "THE BUG: the batch that used to be lost now yields a usable verdict");

console.log("── other places a reply can stop ──");
eq(JSON.parse(closeOpenJson('{"worth_drafting":true,"hypothesis":"X","sources":["a","b')),
   { worth_drafting: true, hypothesis: "X", sources: ["a", "b"] }, "cut inside an array element");
eq(JSON.parse(closeOpenJson('{"worth_drafting":false,"hypothesis":"X",')),
   { worth_drafting: false, hypothesis: "X" }, "cut after a separator");
eq(JSON.parse(closeOpenJson('{"worth_drafting":false,"hypothesis":')),
   { worth_drafting: false }, "cut after a key with no value");
eq(JSON.parse(closeOpenJson('{"worth_drafting":false,"hypo')),
   { worth_drafting: false }, "cut midway through writing a key");
eq(JSON.parse(closeOpenJson('{"insights":[{"kind":"tension","title":"Two reads of the same week')),
   { insights: [{ kind: "tension", title: "Two reads of the same week" }] },
   "a nested analysis object closes at every level");
eq(JSON.parse(closeOpenJson('{"a":"he said \\"go\\" and')),
   { a: 'he said "go" and' }, "escaped quotes do not confuse the scan");

console.log("── what must NOT change ──");
eq(closeOpenJson('{"worth_drafting":false,"why":"greeting only"}'), null,
   "a complete reply reports nothing to repair");
eq(parseModelJson('{"worth_drafting":false,"why":"greeting only"}', "scout"),
   { worth_drafting: false, why: "greeting only" }, "a complete reply parses untouched");
eq(parseModelJson('Here is the verdict:\n{"worth_drafting":false}\nHope that helps.', "scout"),
   { worth_drafting: false }, "prose around the object is still stripped");
eq(parseModelJson('{"nested":{"a":1},"b":[1,2]}', "x"), { nested: { a: 1 }, b: [1, 2] },
   "nested structures survive the normal path");
throws(() => parseModelJson("I could not answer that.", "scout"),
   "a reply with no object at all throws, naming the cause");
throws(() => parseModelJson("", "scout"), "an empty reply throws, naming the cause");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
