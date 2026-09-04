/**
 * API keys: encrypted at rest, matched by hash.
 *
 * Six live keys once reached a git repo through a tool's permission file. That
 * particular hole is closed, but a database file on a hosting volume is the
 * same exposure with a different name — and until now a copy of it handed the
 * reader every key in the clear. Keys are encrypted like message content now,
 * with a separate hash for the lookup, because encryption uses a random IV and
 * cannot be matched with `WHERE api_key = ?`.
 *
 * The migration is the risky half: get it wrong and every existing customer is
 * locked out. Those cases are pinned hardest.
 *
 * Run: GW_DB=/tmp/gw-keys.db GW_DATA_KEY=test-key npx tsx test/key-storage-test.ts
 */
if (!process.env.GW_DB) { console.error("Set GW_DB to a disposable path"); process.exit(1); }
process.env.GW_DATA_KEY ||= "key-storage-test-key";

import { createHash, randomBytes } from "node:crypto";

let pass = 0, fail = 0;
const ok = (c: boolean, n: string, extra = "") => {
  if (c) { pass++; console.log(`  ok  ${n}`); }
  else { fail++; console.log(`FAIL  ${n}${extra ? " — " + extra : ""}`); }
};

const {
  db, createUser, getUserByApiKey, getUserById, getUserByEmail, rotateUserApiKey,
  createGroup, createProjectApiKey, getByProjectApiKey, listProjectApiKeys,
  migrateKeyHashes, deleteGroup,
} = await import("../src/db.js");

const raw = (sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as any;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

console.log("── a new account ──");
const u = createUser(`keys-${Date.now()}@ex.com`, "hash", "Kay");
ok(/^gw_[a-f0-9]{36}$/.test(u.api_key), "createUser returns a usable plaintext key", u.api_key);

const stored = raw("SELECT api_key, api_key_hash FROM users WHERE id = ?", u.id);
ok(stored.api_key !== u.api_key, "THE POINT: the stored value is not the key");
ok(stored.api_key.startsWith("enc1:"), "it is encrypted", stored.api_key?.slice(0, 12));
ok(stored.api_key_hash === sha(u.api_key), "and the lookup hash is the SHA-256 of the key");
ok(!JSON.stringify(raw("SELECT * FROM users WHERE id = ?", u.id)).includes(u.api_key),
   "the key appears nowhere in the raw row");

console.log("── it still authenticates ──");
ok(getUserByApiKey(u.api_key)?.id === u.id, "THE RISK: the key still resolves to its owner");
ok(getUserByApiKey("gw_" + randomBytes(18).toString("hex")) === undefined, "a wrong key resolves to nobody");
ok(getUserByApiKey("") === undefined, "an empty key resolves to nobody");
ok(getUserById(u.id)?.api_key === u.api_key, "the owner can still read their key back");
ok(getUserByEmail(u.email)?.api_key === u.api_key, "by email too");

console.log("── rotation ──");
const rotated = rotateUserApiKey(u.id);
ok(rotated !== u.api_key, "rotation issues a different key");
ok(getUserByApiKey(rotated)?.id === u.id, "the new key works");
ok(getUserByApiKey(u.api_key) === undefined, "and the old one is dead immediately");
ok(raw("SELECT api_key FROM users WHERE id = ?", u.id).api_key.startsWith("enc1:"), "the replacement is encrypted too");

console.log("── project keys ──");
const g = createGroup("Key storage");
const pk = createProjectApiKey(g.id, "Production");
ok(/^gw_proj_[a-f0-9]{40}$/.test(pk.key), "createProjectApiKey returns a usable key");
const pkRow = raw("SELECT key, key_hash FROM project_api_keys WHERE id = ?", pk.id);
ok(pkRow.key.startsWith("enc1:") && pkRow.key !== pk.key, "stored encrypted, not in the clear");
ok(pkRow.key_hash === sha(pk.key), "with its lookup hash");
ok(getByProjectApiKey(pk.key)?.id === pk.id, "it authenticates");
ok(getByProjectApiKey("gw_proj_" + randomBytes(20).toString("hex")) === undefined, "a wrong project key does not");
ok(listProjectApiKeys(g.id)[0]?.key === pk.key, "and the console can still show it");

console.log("── the migration: keys issued before any of this existed ──");
const legacyKey = "gw_" + randomBytes(18).toString("hex");
const legacyId = "legacy-" + Date.now();
db.prepare("INSERT INTO users (id, email, password_hash, name, api_key) VALUES (?, ?, ?, ?, ?)")
  .run(legacyId, `legacy-${Date.now()}@ex.com`, "h", "Legacy", legacyKey);
const legacyProj = "gw_proj_" + randomBytes(20).toString("hex");
const legacyProjId = "legacyk-" + Date.now();
db.prepare("INSERT INTO project_api_keys (id, project_id, name, key) VALUES (?, ?, ?, ?)")
  .run(legacyProjId, g.id, "Old", legacyProj);

ok(getUserByApiKey(legacyKey)?.id === legacyId, "a pre-migration key works BEFORE the sweep (plaintext fallback)");
ok(getByProjectApiKey(legacyProj)?.id === legacyProjId, "so does a pre-migration project key");

const moved = migrateKeyHashes();
ok(moved.users >= 1 && moved.projectKeys >= 1, "the sweep converts them", JSON.stringify(moved));
ok(getUserByApiKey(legacyKey)?.id === legacyId, "THE RISK: it still works AFTER the sweep — nobody is locked out");
ok(getByProjectApiKey(legacyProj)?.id === legacyProjId, "project key too");
ok(raw("SELECT api_key FROM users WHERE id = ?", legacyId).api_key.startsWith("enc1:"), "and is now encrypted at rest");
ok(migrateKeyHashes().users === 0, "running the sweep again converts nothing (idempotent)");

db.prepare("DELETE FROM users WHERE id = ?").run(legacyId);
db.prepare("DELETE FROM users WHERE id = ?").run(u.id);
deleteGroup(g.id);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
