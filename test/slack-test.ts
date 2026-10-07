/**
 * The Slack integration, over a real Express app, a real database and a fake
 * Slack Web API. Nothing here reaches Slack or a model.
 *
 * The properties that matter: nothing unsigned is read; an install is bound to
 * the person who started it and only after they consented; only invited,
 * unshared public channels are read, each as its own project; a finding goes
 * back only where it was drawn, once, with buttons whose verdicts are recorded
 * only against that channel's findings; and uninstalling deletes everything.
 *
 * Run: GW_DB=/tmp/gw-slack.db npx tsx test/slack-test.ts
 */
if (!process.env.GW_DB) {
  console.error("Set GW_DB to a disposable path, e.g. GW_DB=/tmp/gw-slack.db");
  process.exit(1);
}
delete process.env.ANTHROPIC_API_KEY;                    // the engine must never be called for real here
process.env.GW_DATA_KEY = "slack-test-data-key";
process.env.SLACK_SIGNING_SECRET = "test-signing-secret";
process.env.SLACK_CLIENT_ID = "111.222";
process.env.SLACK_CLIENT_SECRET = "client-secret";
process.env.GW_DEMO_BEAT_MS = "5";

import http from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, extra = "") => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`); }
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(20); }
  return cond();
}

// ── A fake Slack Web API ────────────────────────────────────────────────────

type Call = { method: string; auth: string; params: Record<string, string> };
const calls: Call[] = [];
const responses: Array<Record<string, unknown>> = [];
let tsCounter = 0;

const slackApi = http.createServer((req, res) => {
  let raw = "";
  req.on("data", c => (raw += c));
  req.on("end", () => {
    const method = String(req.url ?? "").replace(/^\//, "");
    if (method === "response") {                          // a response_url
      responses.push(JSON.parse(raw || "{}"));
      res.writeHead(200).end();
      return;
    }
    const params = Object.fromEntries(new URLSearchParams(raw));
    calls.push({ method, auth: String(req.headers.authorization ?? ""), params });
    let out: Record<string, unknown> = { ok: true };
    if (method === "oauth.v2.access") {
      out = params.code === "good-code"
        ? { ok: true, access_token: "xoxb-test-token", token_type: "bot", scope: "channels:history,chat:write",
            bot_user_id: "UBOT", app_id: "A1", team: { id: "T1", name: "Acme" }, is_enterprise_install: false }
        : { ok: false, error: "invalid_code" };
    } else if (method === "conversations.info") {
      const shared = params.channel === "C2";
      const priv = params.channel === "G9";
      out = { ok: true, channel: { id: params.channel, name: params.channel === "C1" ? "general" : `chan-${params.channel}`,
              is_ext_shared: shared, is_shared: shared, is_private: priv } };
    } else if (method === "users.info") {
      const name = ({ U1: "Ada", U2: "Bo" } as Record<string, string>)[params.user] ?? "";
      out = { ok: true, user: { id: params.user, profile: { display_name: name } } };
    } else if (method === "chat.postMessage") {
      out = { ok: true, ts: `1700000000.${String(++tsCounter).padStart(6, "0")}` };
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
  });
});
await new Promise<void>(r => slackApi.listen(0, "127.0.0.1", r));
const apiBase = `http://127.0.0.1:${(slackApi.address() as AddressInfo).port}`;
process.env.SLACK_API_BASE = apiBase;

// ── The app under test ──────────────────────────────────────────────────────

const express = (await import("express")).default;
const session = (await import("express-session")).default;
const { slackHook, postSlackFindings, SLACK_CONSENT_VERSION } = await import("../src/slack-hook.js");
const adapter = await import("../src/adapters/slack.js");
const db = await import("../src/db.js");

const app = express();
app.use(session({ secret: "test", resave: false, saveUninitialized: false }));
app.get("/__login/:id", (req: any, res) => { req.session.userId = req.params.id; res.end("ok"); });
app.use("/slack", slackHook);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function sign(body: string, ts = Math.floor(Date.now() / 1000), secret = "test-signing-secret") {
  const sig = "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
  return { "X-Slack-Request-Timestamp": String(ts), "X-Slack-Signature": sig };
}
async function slackPost(path: string, body: string, opts: { contentType?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": opts.contentType ?? "application/json", ...(opts.headers ?? sign(body)) },
    body,
  });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
let eventSeq = 0;
const event = (ev: Record<string, unknown>, team = "T1", eventId = `Ev${++eventSeq}`) =>
  JSON.stringify({ type: "event_callback", team_id: team, api_app_id: "A1", event_id: eventId, event: ev });

async function login(userId: string): Promise<string> {
  const res = await fetch(`${base}/__login/${userId}`);
  return String(res.headers.get("set-cookie") ?? "").split(";")[0];
}
async function get(path: string, cookie = "") {
  return fetch(base + path, { redirect: "manual", headers: cookie ? { Cookie: cookie } : {} });
}

const alice = db.createUser(`alice-slack-${Date.now()}@example.com`, "x", "Alice");
const bob = db.createUser(`bob-slack-${Date.now()}@example.com`, "x", "Bob");

// ════ The adapter, without the network ════

console.log("── request signing ──");
{
  const body = '{"a":1}', ts = String(Math.floor(Date.now() / 1000));
  const sig = "v0=" + createHmac("sha256", "s3").update(`v0:${ts}:${body}`).digest("hex");
  ok(adapter.verifySlackSignature("s3", ts, sig, body).ok, "a correctly signed body passes");
  ok(!adapter.verifySlackSignature("other", ts, sig, body).ok, "THE FORGERY: a different secret fails");
  ok(!adapter.verifySlackSignature("s3", ts, sig, '{"a":2}').ok, "a tampered body fails");
  ok(!adapter.verifySlackSignature("s3", String(Number(ts) - 600), sig, body).ok, "a replay ten minutes old fails");
  ok(!adapter.verifySlackSignature("s3", undefined, undefined, body).ok, "missing headers fail");
  ok(!adapter.verifySlackSignature(undefined, ts, sig, body).ok, "no secret configured fails closed");
}

console.log("── Slack markup to plain text ──");
{
  const names = new Map([["U1", "Ada"]]);
  const plain = adapter.slackTextToPlain("<@U1> shipped it, see <https://x.com/a|the doc> in <#C9|eng> &amp; <!here>", names);
  ok(plain === "@Ada shipped it, see the doc (https://x.com/a) in #eng & @here", "mentions, links, channels, entities", plain);
  ok(adapter.slackTextToPlain("ask <@U7>") === "ask @someone", "an unresolved mention never leaks an id");
  ok(adapter.mentionedUserIds("<@U1> and <@U2> and <@U1>").join() === "U1,U2", "mentions are collected once each");
}

console.log("── commands ──");
{
  ok(adapter.slackMentionCommand("<@UBOT> memory", "UBOT")?.name === "memory", "a mention command parses");
  const m = adapter.slackMentionCommand("<@UBOT> mute today", "UBOT");
  ok(m?.name === "mute" && m.args === "today", "with its arguments");
  ok(adapter.slackMentionCommand("<@UBOT> what did we decide on pricing?", "UBOT") === null, "a question to the bot is read as work, not a command");
  ok(adapter.slackMentionCommand("memory", "UBOT") === null, "no mention, no command");
  ok(adapter.slackMentionCommand("<@UBOT> help", "UBOT")?.name === "help", "help by mention");
  ok(adapter.slackSlashCommand("unmute").name === "unmute" && adapter.slackSlashCommand("").name === "help"
     && adapter.slackSlashCommand("nonsense").name === "help", "slash text parses, and anything else is help");
}

console.log("── which messages are someone's work ──");
{
  const base_ = { type: "message", channel: "C1", channel_type: "channel", user: "U1", text: "Shipped the rewrite." };
  ok(adapter.shouldIngestSlack(base_, "UBOT"), "a person's message in a public channel");
  ok(!adapter.shouldIngestSlack({ ...base_, bot_id: "B1" }, "UBOT"), "not a bot's");
  ok(!adapter.shouldIngestSlack({ ...base_, user: "UBOT" }, "UBOT"), "not our own");
  ok(!adapter.shouldIngestSlack({ ...base_, subtype: "message_changed" }, "UBOT"), "not an edit");
  ok(!adapter.shouldIngestSlack({ ...base_, subtype: "channel_join" }, "UBOT"), "not a join");
  ok(adapter.shouldIngestSlack({ ...base_, subtype: "thread_broadcast" }, "UBOT"), "a thread reply sent to the channel is work");
  ok(!adapter.shouldIngestSlack({ ...base_, channel_type: "im" }, "UBOT")
     && !adapter.shouldIngestSlack({ ...base_, channel_type: "group" }, "UBOT"), "never a DM or private channel");
  ok(!adapter.shouldIngestSlack({ ...base_, is_ext_shared_channel: true }, "UBOT"), "never a channel shared with another company");
  ok(!adapter.shouldIngestSlack({ ...base_, text: "  " }, "UBOT"), "not an empty message");
}

console.log("── a finding as a Slack message ──");
{
  const msg = adapter.slackFindingMessage({ id: "w-1", kind: "opportunity", title: "A <b> & c", body: "Body text." });
  const section = (msg.blocks[0] as any).text.text as string;
  ok(section.includes("💡 *A &lt;b&gt; &amp; c*") && section.includes("Body text."), "mark, bold title, escaped markup", section);
  const buttons = (msg.blocks[1] as any).elements as any[];
  ok(buttons.length === 3 && buttons.every(b => b.value === "w-1"), "three buttons, each carrying the finding's id");
  ok(buttons.map(b => adapter.FEEDBACK_ACTIONS[b.action_id]).join() === "helpful,wrong,late", "mapped to the three verdicts");
  ok(msg.text.includes("A <b> & c"), "a plain fallback for notifications and screen readers");
}

// ════ The routes ════

console.log("── nothing unsigned is read ──");
{
  const body = event({ type: "message", channel: "C1", channel_type: "channel", user: "U1", text: "hi" });
  ok((await slackPost("/slack/events", body, { headers: {} })).status === 401, "THE FORGERY: no signature is refused");
  ok((await slackPost("/slack/events", body, { headers: sign(body, undefined, "wrong") })).status === 401, "a wrong signature is refused");
  ok((await slackPost("/slack/events", body, { headers: sign(body, Math.floor(Date.now() / 1000) - 900) })).status === 401, "a stale one is refused");
  const challenge = await slackPost("/slack/events", JSON.stringify({ type: "url_verification", challenge: "abc123" }));
  ok(challenge.status === 200 && challenge.json?.challenge === "abc123", "Slack's URL check is answered");
  ok((await slackPost("/slack/commands", "text=memory", { contentType: "application/x-www-form-urlencoded", headers: {} })).status === 401,
     "slash commands are signed too");
}

console.log("── installing ──");
{
  const status = await (await fetch(`${base}/slack/status`)).json() as any;
  ok(status.configured === true && status.consent_version === SLACK_CONSENT_VERSION, "the page can tell it is configured");

  let r = await get("/slack/install");
  ok(r.status === 302 && r.headers.get("location") === "/slack?error=signin", "signed out: sent back to sign in");
  const aliceCookie = await login(alice.id);
  r = await get("/slack/install", aliceCookie);
  ok(r.headers.get("location") === "/slack?error=consent", "no consent: sent back to give it");
  r = await get(`/slack/install?consent=${SLACK_CONSENT_VERSION}`, aliceCookie);
  const loc = new URL(String(r.headers.get("location")));
  ok(loc.origin === "https://slack.com" && loc.pathname === "/oauth/v2/authorize", "consented: off to Slack");
  ok(loc.searchParams.get("client_id") === "111.222" && loc.searchParams.get("scope") === "channels:history,channels:read,chat:write,users:read,commands",
     "asking for the five scopes and nothing more");
  ok(loc.searchParams.get("redirect_uri")?.endsWith("/slack/oauth/callback") === true, "returning to our callback");
  const state = String(loc.searchParams.get("state"));

  r = await get(`/slack/oauth/callback?code=good-code&state=not-a-state`, aliceCookie);
  ok(r.headers.get("location") === "/slack?error=expired", "an unknown state is refused");

  const bobCookie = await login(bob.id);
  r = await get(`/slack/oauth/callback?code=good-code&state=${state}`, bobCookie);
  ok(r.headers.get("location") === "/slack?error=signin", "THE SWAP: a state started by Alice cannot finish in Bob's session");
  r = await get(`/slack/oauth/callback?code=good-code&state=${state}`, aliceCookie);
  ok(r.headers.get("location") === "/slack?error=expired", "and a state is single use, even after a refused attempt");

  r = await get(`/slack/install?consent=${SLACK_CONSENT_VERSION}`, aliceCookie);
  const state2 = String(new URL(String(r.headers.get("location"))).searchParams.get("state"));
  r = await get(`/slack/oauth/callback?code=good-code&state=${state2}`, aliceCookie);
  ok(r.headers.get("location") === "/slack?installed=Acme", "a fresh state completes the install");
  const exchange = calls.find(c => c.method === "oauth.v2.access");
  ok(exchange?.params.client_id === "111.222" && exchange?.params.code === "good-code", "the code was exchanged with our client id");
  const install = db.getSlackInstall("T1");
  ok(install?.installed_by === alice.id && install?.bot_user_id === "UBOT" && install?.consent_version === SLACK_CONSENT_VERSION,
     "bound to Alice, with her consent recorded");
  const stored = (db.db.prepare("SELECT bot_token FROM slack_installs WHERE team_id = 'T1'").get() as any).bot_token;
  ok(install?.bot_token === "xoxb-test-token" && stored !== "xoxb-test-token" && String(stored).startsWith("enc1:"),
     "the token is encrypted at rest and decrypts for use");

  r = await get(`/slack/install?consent=${SLACK_CONSENT_VERSION}`, bobCookie);
  const state3 = String(new URL(String(r.headers.get("location"))).searchParams.get("state"));
  r = await get(`/slack/oauth/callback?code=good-code&state=${state3}`, bobCookie);
  ok(r.headers.get("location") === "/slack?error=taken" && db.getSlackInstall("T1")?.installed_by === alice.id,
     "someone else cannot take over a connected workspace");
}

console.log("── invited to a channel ──");
let project = "";
{
  calls.length = 0;
  await slackPost("/slack/events", event({ type: "member_joined_channel", user: "UBOT", channel: "C1", channel_type: "C" }));
  await until(() => !!db.getSlackChannel("T1", "C1") && calls.some(c => c.method === "chat.postMessage"));
  const ch = db.getSlackChannel("T1", "C1");
  project = ch?.project_id ?? "";
  ok(!!ch && ch.active === 1 && ch.channel_name === "general", "the channel is now read");
  ok(db.getGroup(project)?.name === "Slack: #general (Acme)", "as its own project", db.getGroup(project)?.name);
  ok(db.listMembers(project).some(m => m.user_id === alice.id), "owned by the person who installed it");
  const welcome = calls.find(c => c.method === "chat.postMessage");
  ok(welcome?.params.channel === "C1" && /Hi, I'm GroupWisdom/.test(welcome.params.text) && /30 days/.test(welcome.params.text),
     "and the channel is told what happens now, what is kept and for how long");
  ok(welcome?.auth === "Bearer xoxb-test-token", "posting with the workspace's own token");

  calls.length = 0;
  await slackPost("/slack/events", event({ type: "member_joined_channel", user: "UBOT", channel: "C2", channel_type: "C" }));
  await until(() => calls.some(c => c.method === "chat.postMessage"));
  ok(!db.getSlackChannel("T1", "C2"), "THE SHARED CHANNEL: one shared with another company is not read");
  ok(/shared with people outside/.test(calls.find(c => c.method === "chat.postMessage")?.params.text ?? ""), "and it says why");

  await slackPost("/slack/events", event({ type: "member_joined_channel", user: "U1", channel: "C3", channel_type: "C" }));
  await sleep(100);
  ok(!db.getSlackChannel("T1", "C3"), "a person joining a channel is not an invitation");
}

console.log("── reading a channel ──");
{
  const msg = { type: "message", channel: "C1", channel_type: "channel", user: "U1", ts: "1700000100.000100",
                text: "Rewrite shipped with <@U2>: completion went from 41% to 68%." };
  await slackPost("/slack/events", event(msg, "T1", "EvMsg1"));
  await until(() => db.listItems(project).length === 1);
  const items = db.listItems(project);
  ok(items.length === 1 && items[0].source === "slack" && items[0].channel === "slack:C1", "the message is stored for its channel");
  ok(items[0].content === "Rewrite shipped with @Bo: completion went from 41% to 68%.", "with names in place of ids", items[0].content);
  ok(db.listMembers(project).some(m => m.id === items[0].member_id && m.name === "Ada"), "attributed to the person who wrote it");

  await slackPost("/slack/events", event(msg, "T1", "EvMsg1"), { headers: { ...sign(event(msg, "T1", "EvMsg1")), "X-Slack-Retry-Num": "1" } });
  await sleep(150);
  ok(db.listItems(project).length === 1, "THE RETRY: Slack resending the same event is not a second message");

  await slackPost("/slack/events", event({ ...msg, bot_id: "B1", ts: "1700000101.0" }));
  await slackPost("/slack/events", event({ ...msg, subtype: "channel_join", ts: "1700000102.0" }));
  await slackPost("/slack/events", event({ ...msg, user: "UBOT", ts: "1700000103.0" }));
  await sleep(200);
  ok(db.listItems(project).length === 1, "bots, joins and our own messages are not read");
}

console.log("── commands ──");
{
  calls.length = 0;
  await slackPost("/slack/events", event({ type: "message", channel: "C1", channel_type: "channel", user: "U1",
    ts: "1700000200.000200", text: "<@UBOT> mute" }));
  await until(() => calls.some(c => c.method === "chat.postMessage"));
  ok(db.getSlackChannel("T1", "C1")?.muted_until === 0, "a mention mutes the channel");
  const reply = calls.find(c => c.method === "chat.postMessage");
  ok(reply?.params.thread_ts === "1700000200.000200" && /Quiet from here/.test(reply.params.text), "and answers in the thread it was asked in");
  ok(db.listItems(project).length === 1, "a command is answered, not read as work");

  const form = (text: string, channel = "C1") =>
    new URLSearchParams({ team_id: "T1", channel_id: channel, user_id: "U1", command: "/groupwisdom", text }).toString();
  const slash = (text: string, channel = "C1") =>
    slackPost("/slack/commands", form(text, channel), { contentType: "application/x-www-form-urlencoded", headers: sign(form(text, channel)) });

  let r = await slash("unmute");
  ok(r.json?.response_type === "in_channel" && r.json?.text === "Back on." && db.getSlackChannel("T1", "C1")?.muted_until === -1,
     "/groupwisdom unmute, said to the whole channel");
  r = await slash("memory");
  ok(r.json?.response_type === "ephemeral" && /haven't built up anything/.test(r.json?.text), "memory, privately, honest that it is empty");
  r = await slash("help");
  ok(/groupwisdom memory/.test(r.json?.text ?? ""), "help lists the commands");
  r = await slash("memory", "C3");
  ok(/Invite me with/.test(r.json?.text ?? ""), "in a channel it is not in, it says how to invite it");

  calls.length = 0;
  r = await slash("demo");
  ok(r.json?.response_type === "ephemeral" && /demo/.test(r.json?.text), "the demo starts");
  await until(() => calls.filter(c => c.method === "chat.postMessage").length >= 7, 4000);
  const lines = calls.filter(c => c.method === "chat.postMessage").map(c => c.params.text);
  ok(lines.length === 7 && /presenter/.test(lines[6]), "and runs: intro, five messages, the finding", String(lines.length));
  ok(db.listItems(project).length === 1, "none of the demo enters the channel's memory");
}

console.log("── findings back into the channel ──");
let finding = "";
{
  const w = db.addInsight(project, "opportunity", "Completion lift frees support", "Ada's rewrite and Bo's tickets meet.", { channel: "slack:C1" });
  finding = w.id;
  calls.length = 0;
  await postSlackFindings("T1", "C1", [w], "1700000100.000100");
  const post = calls.find(c => c.method === "chat.postMessage");
  ok(!!post && post.params.channel === "C1", "posted into its channel");
  ok(post?.params.thread_ts === "1700000100.000100" && post?.params.reply_broadcast === "true",
     "as a reply to the message that completed it, also shown in the channel");
  ok(JSON.parse(post?.params.blocks ?? "[]")[1]?.elements?.length === 3, "with its three buttons");

  calls.length = 0;
  await postSlackFindings("T1", "C1", [w], "1700000100.000100");
  ok(!calls.some(c => c.method === "chat.postMessage"), "THE DOUBLE POST: never said twice");

  const otherProject = db.createGroup("not this channel");
  const stray = db.addInsight(otherProject.id, "tension", "From elsewhere", "Body.", { channel: "slack:C1" });
  await postSlackFindings("T1", "C1", [stray]);
  const strayChannel = db.addInsight(project, "tension", "Other channel", "Body.", { channel: "slack:C7" });
  await postSlackFindings("T1", "C1", [strayChannel]);
  ok(!calls.some(c => c.method === "chat.postMessage"), "a finding from another project or channel is never posted here");

  db.setSlackMute("T1", "C1", 0);
  const later = db.addInsight(project, "opportunity", "While muted", "Body.", { channel: "slack:C1" });
  await postSlackFindings("T1", "C1", [later]);
  ok(!calls.some(c => c.method === "chat.postMessage"), "a muted channel hears nothing");
  db.setSlackMute("T1", "C1", -1);
  db.deleteGroup(otherProject.id);
}

console.log("── the buttons ──");
{
  responses.length = 0;
  const press = (value: string, actionId = "gw_helpful", user = "U1") => {
    const payload = JSON.stringify({
      type: "block_actions", team: { id: "T1" }, channel: { id: "C1" }, user: { id: user },
      response_url: `${apiBase}/response`, actions: [{ action_id: actionId, value }],
    });
    const body = new URLSearchParams({ payload }).toString();
    return slackPost("/slack/interactions", body, { contentType: "application/x-www-form-urlencoded", headers: sign(body) });
  };
  const r = await press(finding);
  ok(r.status === 200, "a press is acknowledged at once");
  await until(() => db.listWisdomFeedback(project).length === 1);
  const fb = db.listWisdomFeedback(project);
  ok(fb.length === 1 && fb[0].verdict === "helpful" && fb[0].member === "Ada", "THE SIGNAL: the verdict is recorded, by name");
  await until(() => responses.length === 1);
  ok(responses[0]?.response_type === "ephemeral" && /recorded as helpful/.test(String(responses[0]?.text)), "and thanked privately");

  await press(finding, "gw_wrong");
  await until(() => db.listWisdomFeedback(project)[0]?.verdict === "wrong");
  ok(db.listWisdomFeedback(project).length === 1 && db.listWisdomFeedback(project)[0].verdict === "wrong", "changing your mind replaces your verdict");

  const otherProject = db.createGroup("elsewhere");
  const foreign = db.addInsight(otherProject.id, "tension", "Not here", "Body.");
  await press(foreign.id);
  await sleep(200);
  ok(db.listWisdomFeedback(otherProject.id).length === 0, "a press cannot record a verdict on another project's finding");
  db.deleteGroup(otherProject.id);
}

console.log("── your workspaces, and leaving ──");
{
  const mine = await (await fetch(`${base}/slack/installs`, { headers: { Authorization: `Bearer ${alice.api_key}` } })).json() as any;
  ok(mine.data?.length === 1 && mine.data[0].team_name === "Acme" && mine.data[0].channels?.[0]?.channel_name === "general",
     "Alice sees her workspace and its channel");
  const theirs = await (await fetch(`${base}/slack/installs`, { headers: { Authorization: `Bearer ${bob.api_key}` } })).json() as any;
  ok(theirs.data?.length === 0, "Bob sees nothing of it");
  const refused = await fetch(`${base}/slack/installs/T1`, { method: "DELETE", headers: { Authorization: `Bearer ${bob.api_key}` } });
  ok(refused.status === 403, "Bob cannot disconnect it");

  // A second workspace, removed by Slack rather than by us.
  db.upsertSlackInstall({ teamId: "T2", teamName: "Beta", botToken: "xoxb-two", botUserId: "UBOT2", appId: "A1", scope: "", installedBy: bob.id, consentVersion: SLACK_CONSENT_VERSION });
  const t2 = db.upsertSlackChannel({ teamId: "T2", channelId: "C5", channelName: "ops", ownerUserId: bob.id, teamName: "Beta" }).channel;
  await slackPost("/slack/events", event({ type: "app_uninstalled" }, "T2"));
  await until(() => !db.getSlackInstall("T2"));
  ok(!db.getSlackInstall("T2") && !db.getGroup(t2.project_id) && !db.getSlackChannel("T2", "C5"),
     "THE UNINSTALL: removing the app deletes the workspace's projects, channels and token");

  calls.length = 0;
  const gone = await fetch(`${base}/slack/installs/T1`, { method: "DELETE", headers: { Authorization: `Bearer ${alice.api_key}` } });
  const body = await gone.json() as any;
  ok(gone.status === 200 && body.disconnected === true && body.deleted_projects === 1, "Alice disconnects it");
  ok(calls.some(c => c.method === "apps.uninstall" && c.params.client_id === "111.222"), "Slack is asked to remove the app");
  ok(!db.getSlackInstall("T1") && !db.getGroup(project), "and everything it gave us is gone");
}

console.log("── retention ──");
{
  const g = db.createGroup("retention");
  const old = db.addItem(g.id, { type: "note", title: "old", content: "old", source: "slack" });
  db.addItem(g.id, { type: "note", title: "new", content: "new", source: "slack" });
  const api = db.addItem(g.id, { type: "note", title: "api", content: "api", source: "api" });
  db.db.prepare("UPDATE items SET created_at = datetime('now', '-40 days') WHERE id IN (?, ?)").run(old.id, api.id);
  const n = db.pruneOldSlackItems(30);
  const left = db.listItems(g.id).map(i => i.title).sort().join();
  ok(n === 1 && left === "api,new", "Slack messages older than 30 days go; newer ones and API items stay", left);
  db.deleteGroup(g.id);
}

server.close();
slackApi.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
