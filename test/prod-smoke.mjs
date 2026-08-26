/**
 * Production smoke test — the path a stranger takes on launch day.
 *
 * Read-mostly and self-cleaning: it signs up a throwaway account (or falls
 * back to /v1/demo when signup is closed), creates one project, ingests two
 * small items, reads everything back, and deletes the project. Total model
 * cost is one analysis batch — cents.
 *
 * Run: node test/prod-smoke.mjs [base-url]
 */
const BASE = process.argv[2] ?? "https://testgroupwisdom.com";

let pass = 0, fail = 0, warn = 0;
const failures = [];
const ok = (cond, n, extra = "") => {
  if (cond) { pass++; console.log(`  ok  ${n}`); }
  else { fail++; failures.push(n); console.log(`FAIL  ${n}${extra ? " — " + extra : ""}`); }
};
const note = (n) => { warn++; console.log(`note  ${n}`); };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

async function j(method, path, { key, body, cookie } = {}) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, text, ms, headers: res.headers };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log(`Smoke against ${BASE}\n`);

  // ── The front door ────────────────────────────────────────────────────────
  for (const p of ["/", "/docs", "/account", "/privacy", "/terms", "/teams", "/buzz"]) {
    const r = await j("GET", p);
    ok(r.status === 200, `${p} answers 200 (${r.ms}ms)`);
  }

  // ── Unauthenticated API behaves ───────────────────────────────────────────
  const noauth = await j("GET", "/v1/projects");
  ok(noauth.status === 401 && typeof noauth.json?.error === "string", "/v1 without a key: clean JSON 401");
  ok(!!noauth.headers.get("x-ratelimit-limit"), "rate limit headers present");
  const badjson = await fetch(BASE + "/v1/projects", { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer gw_x" }, body: "{broken" });
  ok(badjson.status === 400, "malformed JSON answers 400, not an HTML error page");

  // ── Get a key the way a stranger would ────────────────────────────────────
  let key = null, cleanupProject = null, viaDemo = false;
  const email = `smoke-${Date.now()}@example.com`;
  const su = await j("POST", "/api/auth/signup", { body: { name: "Smoke Test", email, password: "smoke-" + Date.now() } });
  if (su.status === 201) {
    const cookie = (su.headers.get("set-cookie") ?? "").split(";")[0];
    const me = await j("GET", "/api/me", { cookie });
    ok(me.status === 200 && me.json?.api_key?.startsWith("gw_"), "signup issues a working session and API key");
    key = me.json?.api_key;
  } else {
    note(`signup returned ${su.status} (${su.json?.error ?? "no error"}) — falling back to /v1/demo`);
    const demo = await j("POST", "/v1/demo");
    if (demo.status === 201) {
      viaDemo = true; key = demo.json.api_key; cleanupProject = demo.json.project_id;
      ok(true, "demo provisioning works instead");
    } else {
      ok(false, "no self-serve path to a key", `signup ${su.status}, demo ${demo.status}`);
      finish(); return;
    }
  }

  // ── Deploy marker: the private-webhook guard only exists in the new build ─
  let project = cleanupProject;
  if (!viaDemo) {
    const mk = await j("POST", "/v1/projects", { key, body: { name: "Launch smoke " + new Date().toISOString() } });
    ok(mk.status === 201, "project create 201");
    project = mk.json?.id;
    ok(ISO.test(mk.json?.created_at ?? ""), "created_at is ISO 8601", mk.json?.created_at);
  }
  const marker = await j("PATCH", `/v1/projects/${project}`, { key, body: { webhook_url: "http://localhost:9/x" } });
  ok(marker.status === 400, "DEPLOY MARKER: private webhook_url refused — the launch build is live", `got ${marker.status}`);

  // ── The core loop ─────────────────────────────────────────────────────────
  const ing = await j("POST", `/v1/projects/${project}/ingest`, { key, body: { items: [
    { content: "Smoke check A: the deploy finished and the endpoint answered in time.", contributed_by: "SmokeA" },
    { content: "Smoke check B: a second contributor confirms the same run independently.", contributed_by: "SmokeB" },
  ] } });
  ok(ing.status === 202 && ing.json?.accepted === 2, `ingest accepts (${ing.ms}ms)`);

  await sleep(15000);   // batch window + real model latency

  const items = await j("GET", `/v1/projects/${project}/items`, { key });
  ok(items.json?.total === 2, "both items stored and readable");
  ok(items.json?.data?.every(i => ISO.test(i.created_at)), "item timestamps ISO");
  ok(items.json?.data?.some(i => i.contributed_by === "SmokeA"), "attribution survives the round trip");

  const wis = await j("GET", `/v1/projects/${project}/wisdom?format=full`, { key });
  ok(wis.status === 200, "wisdom endpoint answers");
  ok((wis.json?.data ?? []).every(w => ISO.test(w.created_at)), "wisdom timestamps ISO");

  const gates = await j("GET", `/v1/projects/${project}/gate-records`, { key });
  ok(gates.status === 200 && Array.isArray(gates.json?.records), "gate records readable");
  ok((gates.json?.records?.length ?? 0) > 0 || (wis.json?.data?.length ?? 0) > 0,
     "the engine demonstrably ran: a finding or a recorded reason for silence exists");

  const mem = await j("GET", `/v1/projects/${project}/memory`, { key });
  ok(mem.status === 200, "memory endpoint answers");

  const an1 = await j("POST", `/v1/projects/${project}/analyze`, { key });
  const an2 = await j("POST", `/v1/projects/${project}/analyze`, { key });
  ok(an1.status === 202 && an2.status === 429,
     "DEPLOY MARKER 2: analyze cooldown live (first 202, immediate second 429)", `got ${an1.status}/${an2.status}`);

  if (!viaDemo) {
    const usage = await j("GET", "/v1/usage", { key });
    ok(usage.status === 200 && typeof usage.json?.percent_used === "number", "usage answers with a number");
  }

  // ── Latency picture ───────────────────────────────────────────────────────
  const times = [];
  for (let i = 0; i < 8; i++) times.push((await j("GET", `/v1/projects/${project}`, { key })).ms);
  times.sort((a, b) => a - b);
  const median = times[4];
  ok(median < 1500, `median read latency ${median}ms (p95-ish ${times[7]}ms)`);

  // ── Clean up ──────────────────────────────────────────────────────────────
  if (!viaDemo) {
    const del = await j("DELETE", `/v1/projects/${project}`, { key });
    ok(del.json?.deleted === true, "smoke project deleted");
  } else {
    note("demo project left for the demo account's normal cleanup");
  }

  finish();
}

function finish() {
  console.log(`\n${"=".repeat(52)}\n${pass} passed, ${fail} failed, ${warn} notes`);
  if (failures.length) { for (const f of failures) console.log("  ✗ " + f); }
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error("SMOKE CRASH:", e); process.exit(1); });
