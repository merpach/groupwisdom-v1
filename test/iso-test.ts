/**
 * Timestamps on the way out.
 *
 * The review found created_at coming back as "2026-08-21 22:16:03", which
 * Date.parse reads as local time, so findings sorted above the messages that
 * produced them. These pin the fix and the blast radius of it.
 */
// Refuses to run against a real database. Every run is a fresh throwaway.
if (!process.env.GW_DB) {
  console.error("Set GW_DB to a disposable path, e.g. GW_DB=/tmp/gw-test.db");
  process.exit(1);
}

import { isoTimestamps } from "../src/api-v1.js";

let pass = 0, fail = 0;
const eq = (g: unknown, w: unknown, n: string) => {
  if (JSON.stringify(g) === JSON.stringify(w)) { pass++; console.log(`  ok  ${n}`); }
  else { fail++; console.log(`FAIL  ${n}\n      got:  ${JSON.stringify(g)}\n      want: ${JSON.stringify(w)}`); }
};

const RAW = "2026-08-21 22:16:03", ISO = "2026-08-21T22:16:03Z";

eq(isoTimestamps({ created_at: RAW }), { created_at: ISO }, "created_at becomes ISO 8601 with a zone");
eq(isoTimestamps({ updated_at: RAW, last_used_at: RAW }), { updated_at: ISO, last_used_at: ISO },
  "every _at key, not just created_at");
eq(isoTimestamps({ data: [{ created_at: RAW }] }), { data: [{ created_at: ISO }] }, "inside arrays");
eq(isoTimestamps({ a: { b: { created_at: RAW } } }), { a: { b: { created_at: ISO } } }, "arbitrarily nested");

// The reason this is keyed on _at rather than pattern-matching every string.
eq(isoTimestamps({ content: RAW }), { content: RAW },
  "THE CORRUPTION: a message whose text happens to be a date is left alone");
eq(isoTimestamps({ title: `Standup ${RAW}` }), { title: `Standup ${RAW}` }, "and so is a title containing one");

eq(isoTimestamps({ created_at: null }), { created_at: null }, "null survives");
eq(isoTimestamps({ created_at: ISO }), { created_at: ISO }, "an already-ISO value is not double-converted");
eq(isoTimestamps({ created_at: "not a date" }), { created_at: "not a date" }, "a non-timestamp _at is untouched");
eq(isoTimestamps({ percent_used: 0, limit_reached: false }), { percent_used: 0, limit_reached: false },
  "non-string values pass through");

// The exact value from the review, end to end.
const finding = { id: "w1", title: "t", created_at: "2026-08-21 22:16:03", do_next: null };
const out = isoTimestamps(finding) as any;
eq(Number.isFinite(Date.parse(out.created_at)), true, "the result parses");
eq(new Date(out.created_at).toISOString(), "2026-08-21T22:16:03.000Z",
  "THE BUG: and parses as UTC, not as local time five hours out");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
