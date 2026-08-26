/**
 * The /teams routes, over a real Express app and a real database.
 *
 * The properties under test are the ones where a mistake is expensive: an
 * unverified caller cannot reach the handler at all, and a valid pairing code
 * cannot be aimed at a project its holder does not own.
 */
// Refuses to run against a real database. Every run is a fresh throwaway.
if (!process.env.GW_DB) {
  console.error("Set GW_DB to a disposable path, e.g. GW_DB=/tmp/gw-test.db");
  process.exit(1);
}

import express from "express";
import type { AddressInfo } from "node:net";
import { teamsHook } from "../src/teams-hook.js";
import {
  createUser, createGroup, deleteGroup,
  startTeamsPairing, getTeamsInstall, getPendingTeamsInstall,
  rememberTeamsConversation,
} from "../src/db.js";

let pass = 0, fail = 0;
const eq = (g: unknown, w: unknown, n: string) => {
  if (JSON.stringify(g) === JSON.stringify(w)) { pass++; console.log(`  ok  ${n}`); }
  else { fail++; console.log(`FAIL  ${n}\n      got:  ${JSON.stringify(g)}\n      want: ${JSON.stringify(w)}`); }
};

const app = express();
app.use(express.json());
app.use("/teams", teamsHook);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

async function call(method: string, path: string, opts: { key?: string; body?: any; auth?: string } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(opts.key ? { Authorization: `Bearer ${opts.key}` } : {}),
      ...(opts.auth ? { Authorization: opts.auth } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

const alice = createUser(`alice-${Date.now()}@example.com`, "x", "Alice");
const bob   = createUser(`bob-${Date.now()}@example.com`, "x", "Bob");
const aliceProject = createGroup("Alice's project");
const bobProject   = createGroup("Bob's project");
// createGroup does not attach an owner, so bind them the way the app does.
import { addMember } from "../src/db.js";
addMember(aliceProject.id, "Alice", "owner", alice.email, alice.id);
addMember(bobProject.id, "Bob", "owner", bob.email, bob.id);

async function main() {
  console.log("── the Bot Framework endpoint is not open to the public ──");
  const noAuth = await call("POST", "/teams/messages", { body: { type: "message", serviceUrl: "https://smba.trafficmanager.net/amer/" } });
  eq(noAuth.status, 401, "THE FORGERY: an unsigned activity is refused before the body is read");

  // Without an app id configured, verification short-circuits on "no audience to
  // check against" and this test would pass without ever reaching the parser.
  process.env.TEAMS_APP_ID = "11111111-2222-3333-4444-555555555555";
  const junk = await call("POST", "/teams/messages", {
    auth: "Bearer not.a.jwt",
    body: { type: "message", serviceUrl: "https://smba.trafficmanager.net/amer/" },
  });
  eq(junk.status, 401, "and so is a malformed token, with an app id actually configured");

  const noneAlg = Buffer.from(JSON.stringify({ alg: "none", kid: "x" })).toString("base64url")
    + "." + Buffer.from(JSON.stringify({ iss: "https://api.botframework.com", aud: process.env.TEAMS_APP_ID })).toString("base64url")
    + ".";
  eq((await call("POST", "/teams/messages", {
    auth: `Bearer ${noneAlg}`,
    body: { type: "message", serviceUrl: "https://smba.trafficmanager.net/amer/" },
  })).status, 401, "THE CLASSIC: alg=none with correct-looking claims is still refused");
  eq(/reason|alg|kid|signature/i.test(junk.text), false,
    "the refusal never says which check failed — that would be a how-to");

  console.log("\n── claiming a team ──");
  const pending = startTeamsPairing({ teamId: "route-team", teamName: "Eng", serviceUrl: "https://smba.trafficmanager.net/amer/", conversationId: "conv-1" });
  rememberTeamsConversation({ channelId: "route-ch", teamId: "route-team", conversationId: "conv-1", serviceUrl: "https://smba.trafficmanager.net/amer/", channelName: "General" });

  eq((await call("POST", "/teams/claim", { body: { code: pending.code, project_id: aliceProject.id } })).status, 401,
    "a claim with no credentials is refused");

  eq((await call("POST", "/teams/claim", { key: alice.api_key, body: { code: pending.code } })).status, 400,
    "and one missing the project");

  const hijack = await call("POST", "/teams/claim", { key: bob.api_key, body: { code: pending.code, project_id: aliceProject.id } });
  eq(hijack.status, 403, "THE HIJACK: Bob cannot point a code at Alice's project");
  eq(getTeamsInstall("route-team"), undefined, "and nothing was bound");

  const ok = await call("POST", "/teams/claim", { key: alice.api_key, body: { code: pending.code, project_id: aliceProject.id } });
  eq(ok.status, 200, "Alice can claim it against her own project");
  eq(ok.json?.connected, true, "and is told so");
  eq(getTeamsInstall("route-team")?.project_id, aliceProject.id, "the team is bound");
  eq(getPendingTeamsInstall("route-team"), undefined, "the code is spent");

  const replay = await call("POST", "/teams/claim", { key: alice.api_key, body: { code: pending.code, project_id: aliceProject.id } });
  eq(replay.status, 404, "THE REPLAY: the same code cannot be claimed twice");

  console.log("\n── listing and unbinding ──");
  const mine = await call("GET", "/teams/installs", { key: alice.api_key });
  eq(mine.json?.data?.length, 1, "Alice sees her team");
  eq(mine.json?.data?.[0]?.channels?.[0]?.channel_name, "General", "with its channels");

  const theirs = await call("GET", "/teams/installs", { key: bob.api_key });
  eq(theirs.json?.data?.length, 0, "Bob sees nothing of hers");

  eq((await call("DELETE", "/teams/installs/route-team", { key: bob.api_key })).status, 403,
    "and cannot disconnect it");
  eq((await call("DELETE", "/teams/installs/route-team", { key: alice.api_key })).status, 200,
    "Alice can");
  eq(getTeamsInstall("route-team"), undefined, "and it is gone");

  deleteGroup(aliceProject.id); deleteGroup(bobProject.id);
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
