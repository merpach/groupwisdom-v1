/**
 * The limiter that counts rejections.
 *
 * Every public route had a limit except the Bot Framework endpoint, and the
 * usual limit would have been wrong there: every customer's Teams messages
 * arrive from Microsoft's shared addresses, so counting requests per address
 * would slow real customers together. Counting rejections never touches a
 * caller whose token verifies and still cuts off an address throwing forged
 * activities at the URL.
 *
 * Run: npx tsx test/ratelimit-test.ts
 */
import express from "express";
import type { AddressInfo } from "node:net";
import { rateLimit } from "../src/ratelimit.js";

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, extra = "") => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`); }
};

const app = express();
app.set("trust proxy", 1);
app.use("/hook", rateLimit({ name: "hook", windowMs: 60_000, max: 3, failuresOnly: true }));
app.post("/hook", (req, res) => req.headers.authorization ? res.status(200).end() : res.status(401).json({ error: "Unauthorized." }));
app.use("/plain", rateLimit({ name: "plain", windowMs: 60_000, max: 2 }));
app.get("/plain", (_req, res) => res.status(200).end());
app.use("/short", rateLimit({ name: "short", windowMs: 200, max: 1, failuresOnly: true }));
app.post("/short", (_req, res) => res.status(401).end());

const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const hit = (path: string, headers: Record<string, string> = {}, method = "POST") =>
  fetch(base + path, { method, headers }).then(r => r.status);

console.log("── a verified caller is never slowed ──");
const good: number[] = [];
for (let i = 0; i < 10; i++) good.push(await hit("/hook", { authorization: "Bearer ok" }));
ok(good.every(s => s === 200), "ten verified requests in a row all pass: successes are never counted", good.join(","));

console.log("── an address that keeps failing is cut off ──");
const bad = [await hit("/hook"), await hit("/hook"), await hit("/hook")];
ok(bad.every(s => s === 401), "the first three rejections are ordinary 401s", bad.join(","));
ok(await hit("/hook") === 429, "THE FLOOD: the fourth request from that address is refused before the handler runs");
ok(await hit("/hook", { authorization: "Bearer ok" }) === 429, "and the address stays refused for the window, verified or not");
ok(await hit("/hook", { authorization: "Bearer ok", "x-forwarded-for": "203.0.113.9" }) === 200, "another address is unaffected");

console.log("── the request-counting mode is unchanged ──");
const plain = [await hit("/plain", {}, "GET"), await hit("/plain", {}, "GET"), await hit("/plain", {}, "GET")];
ok(plain.join(",") === "200,200,429", "every request counts there, whatever its status", plain.join(","));

console.log("── the window resets ──");
ok(await hit("/short") === 401 && await hit("/short") === 429, "one rejection fills a bucket of one");
await new Promise(r => setTimeout(r, 250));
ok(await hit("/short") === 401, "and the address is heard again once the window has passed");

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
