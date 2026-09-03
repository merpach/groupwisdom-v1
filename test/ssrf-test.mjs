/**
 * The webhook target check, against the encodings an attacker actually uses.
 *
 * Two layers. WHATWG URL parsing canonicalises IPv4 before we ever look, so
 * 0x7f.0.0.1 and 2130706433 arrive as 127.0.0.1 and the literal check catches
 * them. What it cannot catch is a perfectly ordinary public hostname that
 * RESOLVES into private space — 169.254.169.254.nip.io is the cloud metadata
 * address wearing a public name — so the resolver has the last word.
 *
 * Run: node test/ssrf-test.mjs
 */
import { lookup } from "node:dns/promises";

let pass = 0, fail = 0;
const ok = (c, n, extra = "") => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${extra ? " — " + extra : ""}`); } };

// Mirrors src/api-v1.ts isPrivateAddress.
function isPrivateAddress(ip) {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const m = v4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    return a === 0 || a === 10 || a === 127 || (a === 192 && b === 168)
      || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  const v6 = ip.toLowerCase().split("%")[0];
  return v6 === "::1" || v6 === "::" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}
function literalError(raw) {
  let u; try { u = new URL(String(raw)); } catch { return "not a valid URL"; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "scheme";
  const host = u.hostname.toLowerCase();
  if (host.startsWith("[") || host.includes(":")) return "ipv6 literal";
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  const privIp = !!m && isPrivateAddress(host);
  const privName = host === "localhost" || host.endsWith(".localhost")
    || host.endsWith(".local") || host.endsWith(".internal");
  return (privIp || privName) ? "private" : null;
}
async function blocked(raw) {
  if (literalError(raw)) return true;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return (await lookup(host, { all: true })).some(a => isPrivateAddress(a.address));
  } catch { return false; }
}

console.log("── addresses that must never be reachable ──");
for (const [url, label] of [
  ["http://127.0.0.1/h",            "loopback"],
  ["http://localhost/h",            "loopback by name"],
  ["http://169.254.169.254/latest", "cloud metadata"],
  ["http://10.0.0.5/h",             "private class A"],
  ["http://192.168.1.9/h",          "private class C"],
  ["http://172.16.0.1/h",           "private class B"],
  ["http://0x7f.0.0.1/h",           "loopback, hex"],
  ["http://2130706433/h",           "loopback, decimal"],
  ["http://127.1/h",                "loopback, short"],
  ["http://[::1]/h",                "IPv6 loopback"],
  ["http://foo.internal/h",         "internal suffix"],
  ["file:///etc/passwd",            "non-http scheme"],
]) ok(await blocked(url), `${label} refused`, url);

console.log("── the gap the literal check cannot see ──");
for (const [url, label] of [
  ["http://169.254.169.254.nip.io/latest", "THE FIX: metadata behind a public name"],
  ["http://127.0.0.1.nip.io/h",            "THE FIX: loopback behind a public name"],
  ["http://localtest.me/h",                "THE FIX: public name resolving to loopback"],
]) {
  ok(literalError(url) === null, `${label} passes the literal check`, "literal check caught it, resolver untested");
  ok(await blocked(url), `${label} is caught by the resolver`, url);
}

console.log("── and real webhooks still work ──");
for (const [url, label] of [
  ["https://hooks.slack.com/services/T/B/x", "Slack"],
  ["https://example.com/webhook",            "an ordinary https endpoint"],
]) ok(!(await blocked(url)), `${label} still allowed`, url);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
