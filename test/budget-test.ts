/**
 * The money math: rolling windows, ownership, and the clamp.
 *
 * These functions decide when a paying account goes silent, so every rule is
 * pinned: spend inside 30 days counts, spend outside does not, deleting a
 * project does not launder spend, and both the per-user and global caps heal
 * as the window rolls rather than tripping once forever.
 */
if (!process.env.GW_DB) {
  console.error("Set GW_DB to a disposable path, e.g. GW_DB=/tmp/gw-budget.db");
  process.exit(1);
}
import {
  db, createUser, createGroup, deleteGroup, addMember,
  recordUsage, getUserTotalCostUsd, getUserUsagePct, isGroupOverBudget, isGlobalOverBudget,
} from "../src/db.js";

let pass = 0, fail = 0;
const eq = (g: unknown, w: unknown, n: string) => {
  if (JSON.stringify(g) === JSON.stringify(w)) { pass++; console.log(`  ok  ${n}`); }
  else { fail++; console.log(`FAIL  ${n}\n      got:  ${JSON.stringify(g)}\n      want: ${JSON.stringify(w)}`); }
};

/** Backdate every usage row for a group, as if the spend happened `days` ago. */
const backdate = (groupId: string, days: number) =>
  db.prepare("UPDATE usage_events SET created_at = datetime('now', ?) WHERE group_id = ?")
    .run(`-${days} days`, groupId);

/** Record roughly `usd` of Haiku spend against a group (output tokens at $5/MTok). */
const spend = (groupId: string, usd: number) =>
  recordUsage(groupId, "claude-haiku-4-5", 0, Math.round(usd / 5e-6), "test");

const u = createUser(`budget-${Date.now()}@ex.com`, "x", "Bea");
const g1 = createGroup("Budget one");
addMember(g1.id, "Bea", "", u.email, u.id);
const g2 = createGroup("Budget two");
addMember(g2.id, "Bea", "", u.email, u.id);

console.log("── counting ──");
eq(getUserTotalCostUsd(u.id), 0, "a fresh account has spent nothing");
spend(g1.id, 10);
eq(Math.round(getUserTotalCostUsd(u.id)), 10, "recent spend counts");
eq(getUserUsagePct(u.id), 20, "and reads as 20% of the $50 cap");
spend(g2.id, 15);
eq(Math.round(getUserTotalCostUsd(u.id)), 25, "spend pools across all the user's projects");

console.log("── the rolling window ──");
backdate(g1.id, 31);
eq(Math.round(getUserTotalCostUsd(u.id)), 15, "THE FUSE: spend older than 30 days stops counting");
backdate(g2.id, 29);
eq(Math.round(getUserTotalCostUsd(u.id)), 15, "spend 29 days old still counts");

console.log("── the cap ──");
eq(isGroupOverBudget(g1.id), false, "$15 in the window is under the $50 cap");
spend(g1.id, 40);
eq(isGroupOverBudget(g1.id), true, "$55 in the window trips it");
eq(isGroupOverBudget(g2.id), true, "for every project the same owner has, not just the spender");
eq(getUserUsagePct(u.id), 100, "and the visible percentage clamps at 100");
backdate(g1.id, 40);
eq(isGroupOverBudget(g1.id), false, "THE HEAL: the same account comes back as the window rolls");

console.log("── deletion does not launder spend ──");
spend(g1.id, 60);
eq(isGroupOverBudget(g2.id), true, "over budget again");
deleteGroup(g1.id);
eq(isGroupOverBudget(g2.id), true, "deleting the spending project changes nothing — spend is stamped to the user");

console.log("── the operator kill switch ──");
process.env.GW_GLOBAL_BUDGET_USD = "40";
eq(isGlobalOverBudget(), true, "recent service-wide spend past the cap trips it");
db.prepare("UPDATE usage_events SET created_at = datetime('now', '-31 days')").run();
eq(isGlobalOverBudget(), false, "but last month's spend no longer keeps the whole service dead");
delete process.env.GW_GLOBAL_BUDGET_USD;

deleteGroup(g2.id);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
