/**
 * The /v1 API, hammered the way strangers will.
 *
 * The app is assembled with the same middleware, in the same order, as
 * src/index.ts: json parsing, the JSON error handler, the rate limiters, the
 * router. Anthropic is a local fake that can run the full pipeline, so a
 * speaking flow is real end to end — batch timer, four stages, dedupe,
 * webhook signature — with deterministic replies.
 *
 * Two app instances: a functional one with the limiter raised out of the way,
 * and a limits one with production numbers, so four hundred functional
 * assertions do not trip the very 429 they are trying to verify.
 */
// Refuses to run against a real database. Every run is a fresh throwaway.
if (!process.env.GW_DB) {
  console.error("Set GW_DB to a disposable path, e.g. GW_DB=/tmp/gw-test.db");
  process.exit(1);
}
// Without these the engine quietly falls back to its offline mock, the fake
// below is never called, and the speaking flow fails as though the webhook
// were broken. Refuse rather than report a fault that isn't there.
if (!process.env.ANTHROPIC_API_KEY || !process.env.ANTHROPIC_BASE_URL) {
  console.error("Run this through `npm run test:api` — it points the SDK at the local fake.");
  process.exit(1);
}

import express from "express";
import http from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";


let pass = 0, fail = 0;
const failures: string[] = [];
const eq = (g: unknown, w: unknown, n: string) => {
  if (JSON.stringify(g) === JSON.stringify(w)) { pass++; }
  else { fail++; failures.push(n); console.log(`FAIL  ${n}\n      got:  ${JSON.stringify(g)?.slice(0, 300)}\n      want: ${JSON.stringify(w)?.slice(0, 300)}`); }
};
const ok = (cond: boolean, n: string) => eq(!!cond, true, n);
const section = (t: string) => console.log(`\n== ${t} ==`);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const isIso = (v: unknown) => typeof v === "string" && ISO.test(v);

// ── Fake Anthropic: full pipeline, unique titles, call counting ─────────────
const calls: Record<string, number> = {};
let nonce = 0;

const anthropic = http.createServer((req, res) => {
  let raw = ""; req.on("data", c => raw += c);
  req.on("end", () => {
    let b: any = {}; try { b = JSON.parse(raw); } catch {}
    const prompt = (typeof b.system === "string" ? b.system : "") + "\n" +
      (b.messages ?? []).map((m: any) => typeof m.content === "string" ? m.content
        : (m.content ?? []).map((c: any) => c.text ?? "").join("")).join("\n");

    let stage = "other", text = "";
    if (prompt.includes('"contributed"')) {
      stage = "memory";
      text = JSON.stringify({ purpose: "p", facts: [{ fact: `established fact ${++nonce}`, by: "Ada", sources: [] }],
        decisions: [], open_questions: [], contributed: true, why: "work" });
    } else if (prompt.includes('"worth_drafting"')) {
      stage = "scout";
      text = JSON.stringify({ worth_drafting: true, hypothesis: "h", sources: [], why: "" });
    } else if (prompt.includes('"why_silent"')) {
      stage = "editor";
      text = JSON.stringify({ new: [{ kind: "convergence", title: `Distinct finding number ${++nonce} entirely`,
        body: `Ada measured result ${nonce} and Bo confirmed it separately with different words each time.` }], dismiss: [], why_silent: null });
    } else if (prompt.includes("revised_title") || prompt.includes("first-pass AI")) {
      stage = "review";
      text = JSON.stringify([{ id: 0, confidence: "medium", stated_in: null, caveat: null, do_next: null,
        missing_voice: null, keep: true, drop_reason: null, revised_kind: null, revised_title: null, revised_body: null }]);
    } else if (prompt.includes("GroupWisdom insight engine")) {
      stage = "full-analysis";
      text = JSON.stringify({ insights: [{ kind: "opportunity", title: `Full analysis finding ${++nonce} distinct`,
        body: `A separately derived conclusion ${nonce} joining two members' work in new words.` }], knowledge_markdown: "# k" });
    } else if (prompt.includes("indexing a shared knowledge project")) {
      stage = "summary";
      text = "A short project summary.";
    } else {
      text = JSON.stringify({ insights: [], knowledge_markdown: "# k" });
    }
    calls[stage] = (calls[stage] ?? 0) + 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: b.model,
      content: [{ type: "text", text }], stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 10 } }));
  });
});

// ── Webhook receiver: records body + signature header ───────────────────────
type Delivery = { body: any; raw: string; sig: string | null };
const deliveries: Delivery[] = [];
const receiver = http.createServer((req, res) => {
  let raw = ""; req.on("data", c => raw += c);
  req.on("end", () => {
    let body: any = null; try { body = JSON.parse(raw); } catch {}
    deliveries.push({ body, raw, sig: (req.headers["x-groupwisdom-signature"] as string) ?? null });
    res.writeHead(200); res.end("ok");
  });
});

const settle = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  await new Promise<void>(r => anthropic.listen(4713, "127.0.0.1", () => r()));
  await new Promise<void>(r => receiver.listen(0, "127.0.0.1", () => r()));
  const receiverPort = (receiver.address() as AddressInfo).port;

  const db = await import("../src/db.js");
  const { apiv1 } = await import("../src/api-v1.js");
  const { rateLimit, apiKeyOrIp } = await import("../src/ratelimit.js");

  // Assembled the way index.ts assembles it, including the error handler that
  // keeps malformed bodies answering in JSON.
  function buildApp(v1Max: number) {
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use((err: any, _req: any, res: any, next: any) => {
      if (!err) return next();
      if (err.type === "entity.parse.failed" || err instanceof SyntaxError)
        return res.status(400).json({ error: "Request body is not valid JSON." });
      if (err.type === "entity.too.large")
        return res.status(413).json({ error: "Request body is too large (limit 2mb)." });
      return next(err);
    });
    app.use("/v1", rateLimit({ name: "v1-" + v1Max, windowMs: 60_000, max: v1Max, keyFn: apiKeyOrIp }));
    app.use("/v1/demo", rateLimit({ name: "demo-" + v1Max, windowMs: 60 * 60_000, max: 5 }));
    app.use("/v1", apiv1);
    return app;
  }

  const fnApp = buildApp(1_000_000).listen(0);
  const base = `http://127.0.0.1:${(fnApp.address() as AddressInfo).port}/v1`;

  async function call(method: string, path: string, opts: { key?: string; body?: any; rawBody?: string; headers?: Record<string, string> } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(opts.rawBody === undefined && opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(opts.rawBody !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(opts.key ? { Authorization: `Bearer ${opts.key}` } : {}),
        ...(opts.headers ?? {}),
      },
      body: opts.rawBody !== undefined ? opts.rawBody : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, json, text, headers: res.headers };
  }

  // ── Fixtures ──────────────────────────────────────────────────────────────
  const alice = db.createUser(`alice-${Date.now()}@ex.com`, "x", "Alice");
  const bob   = db.createUser(`bob-${Date.now()}@ex.com`, "x", "Bob");

  // ════ S1 · Auth ════
  section("S1 auth");
  eq((await call("GET", "/projects")).status, 401, "no key is 401");
  eq((await call("GET", "/projects", { key: "gw_nonsense" })).status, 401, "garbage key is 401");
  eq((await call("GET", "/projects", { key: "gw_proj_nonsense" })).status, 401, "garbage project key is 401");
  eq((await call("GET", "/projects", { headers: { Authorization: `bearer ${alice.api_key}` } })).status, 200, "lowercase bearer accepted");
  const qk = await fetch(`${base}/projects?key=${alice.api_key}`);
  eq(qk.status, 401, "THE LOGGED CREDENTIAL: a key in the query string no longer authenticates");

  // ════ S2 · Projects CRUD + webhook validation ════
  section("S2 projects");
  eq((await call("POST", "/projects", { key: alice.api_key, body: {} })).status, 400, "create without name is 400");
  eq((await call("POST", "/projects", { key: alice.api_key, body: { name: "   " } })).status, 400, "whitespace name is 400");
  const mk = await call("POST", "/projects", { key: alice.api_key, body: { name: "Alice's launch project" } });
  eq(mk.status, 201, "create is 201");
  const A = mk.json.id;
  ok(isIso(mk.json.created_at), "created_at is ISO on create");
  eq(mk.json.counts, { items: 0, wisdom: 0, insights: 0 }, "counts start at zero, insights alias present");

  const mkB = await call("POST", "/projects", { key: bob.api_key, body: { name: "Bob's project" } });
  const B = mkB.json.id;

  for (const url of ["http://localhost:9999/h", "http://127.0.0.1/h", "https://10.0.0.5/h", "https://192.168.1.9/h",
                     "https://172.20.1.1/h", "https://169.254.169.254/latest", "https://foo.internal/h",
                     "ftp://example.com/h", "javascript:alert(1)", "not a url", "https://[::1]/h"]) {
    eq((await call("PATCH", `/projects/${A}`, { key: alice.api_key, body: { webhook_url: url } })).status, 400,
      `THE SSRF DOOR: webhook_url ${JSON.stringify(url)} is refused`);
  }
  const badCreate = await call("POST", "/projects", { key: alice.api_key, body: { name: "orphan?", webhook_url: "http://localhost/x" } });
  eq(badCreate.status, 400, "create with a private webhook_url is refused");
  const listAfter = await call("GET", "/projects", { key: alice.api_key });
  eq(listAfter.json.filter((p: any) => p.name === "orphan?").length, 0, "and no orphan project was created first");

  const goodHook = await call("PATCH", `/projects/${A}`, { key: alice.api_key, body: { webhook_url: "https://example.com/hook" } });
  eq(goodHook.status, 200, "a public webhook_url is accepted");
  ok(typeof goodHook.json.webhook_secret === "string" && goodHook.json.webhook_secret.length >= 32, "and the signing secret is returned");
  const patchNoHook = await call("PATCH", `/projects/${A}`, { key: alice.api_key, body: {} });
  eq("webhook_secret" in (patchNoHook.json ?? {}), false, "the secret is not repeated on unrelated PATCHes");
  eq((await call("PATCH", `/projects/${A}`, { key: alice.api_key, body: { engine: "gpt9" } })).status, 400, "unknown engine is 400");
  eq((await call("PATCH", `/projects/${A}`, { key: alice.api_key, body: { engine: "muse-spark" } })).status, 200, "valid engine accepted");
  await call("PATCH", `/projects/${A}`, { key: alice.api_key, body: { engine: "claude", webhook_url: null } });

  // ════ S3 · Cross-tenant walls ════
  section("S3 cross-tenant");
  const routes: Array<[string, string, any?]> = [
    ["GET", `/projects/${A}`], ["PATCH", `/projects/${A}`, { name: "x" }], ["DELETE", `/projects/${A}`],
    ["POST", `/projects/${A}/ingest`, { content: "steal" }], ["GET", `/projects/${A}/items`],
    ["GET", `/projects/${A}/wisdom`], ["GET", `/projects/${A}/memory`], ["GET", `/projects/${A}/gate-records`],
    ["POST", `/projects/${A}/analyze`], ["GET", `/projects/${A}/feedback`], ["POST", `/projects/${A}/keys`, { name: "k" }],
    ["GET", `/projects/${A}/keys`], ["POST", `/projects/${A}/test-webhook`], ["POST", `/projects/${A}/rename-contributor`, { from: "a", to: "b" }],
  ];
  for (const [m, p, body] of routes) {
    eq((await call(m, p, { key: bob.api_key, body })).status, 404, `THE WALL: Bob's key on Alice's ${m} ${p.split("/").slice(3).join("/") || "project"} is 404`);
  }
  const keyB = (await call("POST", `/projects/${B}/keys`, { key: bob.api_key, body: { name: "b-key" } })).json.key;
  eq((await call("GET", `/projects/${A}/items`, { key: keyB })).status, 404, "Bob's project key on Alice's project is 404");

  // ════ S4 · Ingest ════
  section("S4 ingest");
  const one = await call("POST", `/projects/${A}/ingest`, { key: alice.api_key,
    body: { title: "Result one", content: "Ada measured 22% faster checkout.", contributed_by: "Ada" } });
  eq(one.status, 202, "single item is 202");
  eq(one.json.accepted, 1, "accepted count 1");
  const bulk = await call("POST", `/projects/${A}/ingest`, { key: alice.api_key, body: { items: [
    { content: "Content-only message with no title at all", contributed_by: "Bo" },
    { url: "https://example.com/report" },
    { title: "", content: "", url: "" },
    null, "just a string", 42,
    { title: 123, contributed_by: 456, type: "weird" },
    { content: "Emoji + unicode: 🚀 café née 中文", contributed_by: "  Ada  " },
  ] } });
  eq(bulk.status, 202, "THE 500 TRAP: nulls, strings, numbers and non-string fields do not crash the request");
  eq(bulk.json.accepted, 4, "and exactly the four real items were stored");
  eq((await call("POST", `/projects/${A}/ingest`, { key: alice.api_key, body: { items: "nope" } })).status, 400, "items as a string is 400");
  eq((await call("POST", `/projects/${A}/ingest`, { key: alice.api_key, body: { items: [] } })).status, 400, "empty items array is 400");
  eq((await call("POST", `/projects/${A}/ingest`, { key: alice.api_key, body: {} })).status, 400, "empty body is 400");
  eq((await call("POST", `/projects/${A}/ingest`, { key: alice.api_key, body: { items: [{}, { title: "" }] } })).status, 400, "all-empty items is 400 not silent success");
  const badJson = await call("POST", `/projects/${A}/ingest`, { key: alice.api_key, rawBody: "{not json" });
  eq(badJson.status, 400, "malformed JSON is 400");
  eq(badJson.json?.error, "Request body is not valid JSON.", "and answers in JSON, not an HTML error page");
  const big = await call("POST", `/projects/${A}/ingest`, { key: alice.api_key, rawBody: JSON.stringify({ content: "x".repeat(2_500_000) }) });
  eq(big.status, 413, "an oversized body is 413");
  eq(typeof big.json?.error, "string", "and 413 answers in JSON too");
  const longName = await call("POST", `/projects/${A}/ingest`, { key: alice.api_key,
    body: { content: "capped contributor", contributed_by: "N".repeat(500) } });
  eq(longName.status, 202, "a 500-char contributor name is accepted");
  const members = db.listMembers(A);
  ok(members.every((m: any) => m.name.length <= 80), "but stored capped at 80 characters");
  eq(members.filter((m: any) => m.name.toLowerCase() === "ada").length, 1, "the same contributor twice is one member, not two");
  eq(members.filter((m: any) => m.name.trim() === "").length, 0, "whitespace contributed_by never creates a nameless member");
  const arr = await call("POST", `/projects/${A}/ingest`, { key: alice.api_key,
    body: [{ content: "top-level array form" }] });
  eq(arr.status, 202, "a top-level array body still works");
  const chan = await call("POST", `/projects/${A}/ingest`, { key: alice.api_key,
    body: { content: "channel capped", channel: "c".repeat(300) } });
  eq(chan.status, 202, "oversized channel accepted");
  const lastItem = db.listItems(A).find((i: any) => i.content === "channel capped");
  eq(lastItem?.channel?.length, 100, "and capped at 100");

  // ════ S5 · Items ════
  section("S5 items");
  const page1 = await call("GET", `/projects/${A}/items?limit=3&offset=0`, { key: alice.api_key });
  eq(page1.json.data.length, 3, "limit honoured");
  eq(page1.json.has_more, true, "has_more true mid-list");
  ok(page1.json.total >= 8, "total counts everything");
  ok(page1.json.data.every((i: any) => isIso(i.created_at)), "item timestamps are ISO");
  ok(page1.json.data.some((i: any) => typeof i.contributed_by === "string"), "contributed_by comes back out");
  const limits = await call("GET", `/projects/${A}/items?limit=99999&offset=-5`, { key: alice.api_key });
  eq(limits.json.limit, 200, "limit clamps at 200");
  eq(limits.json.offset, 0, "negative offset clamps to 0");
  const itemId = page1.json.data[0].id;
  eq((await call("DELETE", `/projects/${A}/items/${itemId}`, { key: alice.api_key })).json.deleted, true, "delete item works");
  eq((await call("DELETE", `/projects/${A}/items/${itemId}`, { key: alice.api_key })).status, 404, "deleting it again is 404");
  eq((await call("DELETE", `/projects/${B}/items/${itemId}`, { key: bob.api_key })).status, 404, "deleting Alice's item via Bob's project is 404");

  // ════ S6 · Wisdom ════
  section("S6 wisdom");
  db.addInsight(A, "tension", "Seeded tension", "Body of the seeded tension.", { confidence: "high" });
  db.addInsight(A, "pattern", "Seeded pattern", "Body of the seeded pattern.", {});
  const simple = await call("GET", `/projects/${A}/wisdom`, { key: alice.api_key });
  eq(Object.keys(simple.json.data[0]).sort(), ["body", "id", "title"], "minimal view is exactly id/title/body");
  const fullW = await call("GET", `/projects/${A}/wisdom?format=full`, { key: alice.api_key });
  eq(Object.keys(fullW.json.data[0]).sort(),
     ["body", "caveat", "channel", "confidence", "created_at", "do_next", "id", "kind", "missing_voice", "stated_in", "status", "title"],
     "full view carries every documented field");
  ok(fullW.json.data.every((w: any) => isIso(w.created_at)), "wisdom timestamps are ISO");
  eq((await call("GET", `/projects/${A}/wisdom?kind=sparkle`, { key: alice.api_key })).status, 400, "unknown kind is 400, not an empty list");
  eq((await call("GET", `/projects/${A}/wisdom?kind=tension`, { key: alice.api_key })).json.data.length, 1, "kind filter works");
  const legacy = await call("GET", `/projects/${A}/insights?format=full`, { key: alice.api_key });
  eq(legacy.json.total, fullW.json.total, "legacy /insights matches /wisdom exactly");

  // ════ S7 · Keys ════
  section("S7 keys");
  const pkey = await call("POST", `/projects/${A}/keys`, { key: alice.api_key, body: { name: "ci" } });
  eq(pkey.status, 201, "project key created");
  ok(pkey.json.key.startsWith("gw_proj_"), "with the documented prefix");
  ok(isIso(pkey.json.created_at), "key created_at is ISO");
  const klist = await call("GET", `/projects/${A}/keys`, { key: alice.api_key });
  ok(klist.json.every((k: any) => !("key" in k)), "THE LEAK: listing keys never returns full keys");
  ok(klist.json.every((k: any) => k.key_preview.endsWith("...")), "only previews");
  eq((await call("GET", `/projects/${A}/items`, { key: pkey.json.key })).status, 200, "project key reads its project");
  eq((await call("GET", "/projects", { key: pkey.json.key })).status, 403, "but cannot list all projects");
  eq((await call("POST", "/projects", { key: pkey.json.key, body: { name: "no" } })).status, 403, "or create projects");
  eq((await call("DELETE", `/projects/${A}`, { key: pkey.json.key })).status, 403, "or delete its own project");
  eq((await call("GET", "/usage", { key: pkey.json.key })).status, 403, "or read account usage");
  eq((await call("POST", `/projects/${A}/keys`, { key: pkey.json.key, body: { name: "x" } })).status, 403, "or mint more keys");
  eq((await call("DELETE", `/projects/${A}/keys/${pkey.json.id}`, { key: alice.api_key })).json.revoked, true, "revoke works");
  eq((await call("GET", `/projects/${A}/items`, { key: pkey.json.key })).status, 401, "THE DEAD KEY: a revoked key stops working immediately");

  // ════ S8 · Usage ════
  section("S8 usage");
  const usage = await call("GET", "/usage", { key: alice.api_key });
  eq(usage.status, 200, "usage answers");
  ok(typeof usage.json.percent_used === "number" && typeof usage.json.limit_reached === "boolean", "with the documented shape");

  // ════ S9 · Feedback ════
  section("S9 feedback");
  const wid = fullW.json.data[0].id;
  eq((await call("POST", `/wisdom/${wid}/feedback`, { key: alice.api_key, body: { verdict: "HELPFUL", member: "Ada" } })).status, 201, "verdict is case-insensitive");
  eq((await call("POST", `/wisdom/${wid}/feedback`, { key: alice.api_key, body: { verdict: "meh" } })).status, 400, "unknown verdict is 400");
  eq((await call("POST", `/wisdom/${wid}/feedback`, { key: bob.api_key, body: { verdict: "helpful" } })).status, 404, "THE PROBE: Bob cannot leave feedback on Alice's wisdom, and learns nothing");
  eq((await call("POST", `/wisdom/does-not-exist/feedback`, { key: alice.api_key, body: { verdict: "helpful" } })).status, 404, "nonexistent wisdom is the same 404");
  await call("POST", `/wisdom/${wid}/feedback`, { key: alice.api_key, body: { verdict: "wrong", member: "Ada", source_event_id: "ev-1" } });
  const fb = await call("GET", `/projects/${A}/feedback`, { key: alice.api_key });
  eq(fb.json.feedback.filter((f: any) => f.member === "Ada").length, 1, "one live verdict per member per finding, newest wins");
  eq((await call("DELETE", `/wisdom/feedback/ev-1`, { key: bob.api_key })).status, 404, "Bob cannot withdraw Alice's verdict by public event id");
  eq((await call("DELETE", `/wisdom/feedback/ev-1`, { key: alice.api_key })).json.withdrawn, true, "Alice can");
  eq((await call("GET", "/feedback/summary", { key: alice.api_key })).status, 404, "admin summary without GW_ADMIN_EMAIL is 404");
  process.env.GW_ADMIN_EMAIL = alice.email;
  eq((await call("GET", "/feedback/summary", { key: alice.api_key })).status, 200, "with it set, the admin sees totals");
  eq((await call("GET", "/feedback/summary", { key: bob.api_key })).status, 404, "and a non-admin still sees 404, indistinguishable from unset");
  delete process.env.GW_ADMIN_EMAIL;

  // ════ S10 · Memory, gate records, rename ════
  section("S10 transparency");
  const memB = await call("GET", `/projects/${B}/memory`, { key: bob.api_key });
  eq(memB.json, { memory: null, updated_at: null }, "no memory yet reads as null, not 500");
  db.setGroupMemoryRaw(B, "{corrupt json!!");
  eq((await call("GET", `/projects/${B}/memory`, { key: bob.api_key })).json.memory, null, "THE CORRUPT ROW: garbage in the memory column surfaces as null, not 500");
  const gr = await call("GET", `/projects/${A}/gate-records?limit=99999`, { key: alice.api_key });
  eq(gr.status, 200, "gate records answer");
  eq((await call("POST", `/projects/${A}/rename-contributor`, { key: alice.api_key, body: { from: "Bo", to: "Beatrice" } })).json.renamed, true, "rename works");
  eq((await call("POST", `/projects/${A}/rename-contributor`, { key: alice.api_key, body: { from: "x" } })).status, 400, "rename without to is 400");
  eq((await call("POST", `/projects/${A}/rename-contributor`, { key: alice.api_key, body: { from: "x", to: "y".repeat(60) } })).status, 400, "over-long name is 400");

  // ════ S11 · Webhook end to end ════
  section("S11 webhook flow");
  process.env.GW_WEBHOOK_ALLOW_PRIVATE = "1";
  const hookUrl = `http://127.0.0.1:${receiverPort}/hook`;
  const hooked = await call("PATCH", `/projects/${A}`, { key: alice.api_key, body: { webhook_url: hookUrl } });
  eq(hooked.status, 200, "private webhook allowed under the self-host flag");
  const secret = hooked.json.webhook_secret;
  ok(typeof secret === "string", "fresh secret issued");

  const tw = await call("POST", `/projects/${A}/test-webhook`, { key: alice.api_key });
  eq(tw.json, { sent: true, status: 200 }, "test-webhook delivers and reports downstream status");
  await settle(150);
  eq(deliveries.length, 1, "receiver got the test event");
  eq(deliveries[0].body.event, "test", "as event=test");
  ok(deliveries[0].sig?.startsWith("sha256="), "signed");
  eq(deliveries[0].sig, "sha256=" + createHmac("sha256", secret).update(deliveries[0].raw).digest("hex"),
    "THE SIGNATURE: verifiable with the secret from PATCH");

  deliveries.length = 0;
  const speak = await call("POST", `/projects/${A}/ingest`, { key: alice.api_key, body: { items: [
    { content: "Ada shipped the rewrite and completion rose from 41% to 68%.", contributed_by: "Ada" },
    { content: "Beatrice found 14 of 22 support emails were setup problems.", contributed_by: "Beatrice" },
  ] } });
  eq(speak.status, 202, "speaking flow ingests");
  await settle(5200);                               // 3s batch + pipeline
  eq(deliveries.length, 1, "THE PUSH: analysis produced a finding and the webhook fired once");
  if (!deliveries.length) {
    // Silence here is usually the engine deciding, not the webhook breaking.
    // Print the reason it recorded so the next reader is not left guessing.
    const g = await call("GET", `/projects/${A}/gate-records`, { key: alice.api_key });
    for (const r of (g.json?.records ?? []).slice(0, 6))
      console.log(`      why: [${r.stage}/${r.verdict}] ${r.reason ?? r.title ?? ""}`);
  }
  const d = deliveries[0];
  eq(d.body.event, "insights.created", "event name preserved for old receivers");
  ok(Array.isArray(d.body.wisdom) && Array.isArray(d.body.insights), "wisdom and insights mirror");
  eq(JSON.stringify(d.body.wisdom), JSON.stringify(d.body.insights), "identically");
  ok(d.body.wisdom.every((w: any) => isIso(w.created_at)), "THE OTHER TIMELINE: webhook payloads carry ISO timestamps too");
  eq(d.sig, "sha256=" + createHmac("sha256", secret).update(d.raw).digest("hex"), "and verify against the same secret");

  // ════ S12 · Analyze ════
  section("S12 analyze");
  deliveries.length = 0;
  const an = await call("POST", `/projects/${A}/analyze`, { key: alice.api_key });
  eq(an.status, 202, "analyze accepted");
  await settle(1200);
  eq(deliveries.length, 1, "full analysis fired the webhook");
  eq(deliveries[0].body.wisdom.length >= 1, true, "with the new finding");
  const again = await call("POST", `/projects/${A}/analyze`, { key: alice.api_key });
  eq(again.status, 429, "THE EXPENSIVE LOOP: a second full analysis inside the window is refused");
  ok(!!again.headers.get("retry-after"), "with a Retry-After");
  ok(/whole project/.test(again.json?.error ?? ""), "and an error that says why");
  const burst429 = await Promise.all(Array.from({ length: 10 }, () => call("POST", `/projects/${A}/analyze`, { key: alice.api_key })));
  ok(burst429.every(r => r.status === 429), "a parallel burst is entirely refused");
  eq((await call("POST", `/projects/${B}/analyze`, { key: bob.api_key })).status, 202, "another project is unaffected");
  process.env.GW_ANALYZE_COOLDOWN_MIN = "0";
  const burst = await Promise.all(Array.from({ length: 10 }, () => call("POST", `/projects/${A}/analyze`, { key: alice.api_key })));
  ok(burst.every(r => r.status === 202), "with the cooldown disabled, ten parallel analyzes all 202 and nothing crashes");
  delete process.env.GW_ANALYZE_COOLDOWN_MIN;
  await settle(1500);

  // ════ S13 · Summary debounce ════
  section("S13 summary cost");
  const before = calls["summary"] ?? 0;
  for (let i = 0; i < 5; i++) {
    await call("POST", `/projects/${B}/ingest`, { key: bob.api_key, body: { content: `note ${i}`, contributed_by: "Bob" } });
  }
  await settle(300);
  const after = calls["summary"] ?? 0;
  ok(after - before <= 1, `THE PER-REQUEST MODEL CALL: five ingests produce at most one summary refresh (got ${after - before})`);

  // ════ S14 · Concurrency ════
  section("S14 concurrency");
  const mkC = await call("POST", "/projects", { key: alice.api_key, body: { name: "Concurrency" } });
  const C = mkC.json.id;
  const mixed = await Promise.all([
    ...Array.from({ length: 60 }, (_, i) => call("POST", `/projects/${C}/ingest`, { key: alice.api_key,
      body: { content: `parallel item ${i} with enough words to be real`, contributed_by: `P${i % 7}` } })),
    ...Array.from({ length: 40 }, () => call("GET", `/projects/${C}/items`, { key: alice.api_key })),
    ...Array.from({ length: 20 }, () => call("GET", `/projects/${C}/wisdom?format=full`, { key: alice.api_key })),
    ...Array.from({ length: 10 }, (_, i) => call("PATCH", `/projects/${C}`, { key: alice.api_key, body: { engine: i % 2 ? "claude" : "muse-spark" } })),
  ]);
  eq(mixed.filter(r => r.status >= 500).length, 0, "THE MELTDOWN: 130 parallel requests, zero 500s");
  eq(mixed.filter(r => r.status === 202).length, 60, "every parallel ingest accepted");
  await settle(4200);
  const cItems = await call("GET", `/projects/${C}/items?limit=200`, { key: alice.api_key });
  eq(cItems.json.total, 60, "all 60 items stored exactly once");
  const cMembers = db.listMembers(C).filter((m: any) => m.name.startsWith("P"));
  eq(cMembers.length, 7, "seven contributors resolved to exactly seven members under parallel ingest");

  // ════ S15 · Delete cascades ════
  section("S15 delete");
  eq((await call("DELETE", `/projects/${C}`, { key: alice.api_key })).json.deleted, true, "delete project");
  eq((await call("GET", `/projects/${C}`, { key: alice.api_key })).status, 404, "gone");
  const pk2 = await call("POST", `/projects/${B}/keys`, { key: bob.api_key, body: { name: "dying" } });
  await call("DELETE", `/projects/${B}`, { key: bob.api_key });
  eq((await call("GET", `/projects/${B}/items`, { key: pk2.json.key })).status, 401, "THE ORPHAN KEY: a project key dies with its project");

  // ════ S16 · Demo + production rate limits (separate app, real numbers) ════
  section("S16 demo + limits");
  eq((await call("POST", "/demo")).status, 503, "demo without the demo user is 503, not a crash");
  db.createUser("demo@groupwisdom.internal", "x", "Demo");
  const demo = await call("POST", "/demo");
  eq(demo.status, 201, "demo provisions");
  ok(demo.json.api_key?.startsWith("gw_proj_") && demo.json.project_id, "with a scoped key and project");
  eq((await call("POST", `/projects/${demo.json.project_id}/ingest`, { key: demo.json.api_key, body: { content: "demo item" } })).status, 202,
    "and the demo key actually works");

  const limApp = buildApp(240).listen(0);
  const limBase = `http://127.0.0.1:${(limApp.address() as AddressInfo).port}/v1`;
  const carol = db.createUser(`carol-${Date.now()}@ex.com`, "x", "Carol");
  let got429 = null as any;
  for (let i = 0; i < 245; i++) {
    const r = await fetch(`${limBase}/usage`, { headers: { Authorization: `Bearer ${carol.api_key}` } });
    if (r.status === 429) { got429 = { at: i + 1, retry: r.headers.get("retry-after"), body: await r.json() }; break; }
  }
  ok(!!got429 && got429.at === 241, `the 241st request in a minute is refused (got ${got429?.at})`);
  ok(!!got429?.retry, "with a Retry-After header");
  eq(typeof got429?.body?.error, "string", "and a JSON error body");
  const other = await fetch(`${limBase}/usage`, { headers: { Authorization: `Bearer ${alice.api_key}` } });
  eq(other.status, 200, "another key is unaffected");
  const demoLimited: number[] = [];
  for (let i = 0; i < 7; i++) demoLimited.push((await fetch(`${limBase}/demo`, { method: "POST" })).status);
  eq(demoLimited.filter(s => s === 429).length >= 2, true, "THE PROJECT MINT: unauthenticated /demo hits its own 5-per-hour wall");
  limApp.close();

  // ── Verdict ───────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(60)}\n${pass} passed, ${fail} failed`);
  if (failures.length) { console.log("Failures:"); for (const f of failures) console.log("  ✗ " + f); }
  fnApp.close(); anthropic.close(); receiver.close();
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("HARNESS CRASH:", e); process.exit(1); });
