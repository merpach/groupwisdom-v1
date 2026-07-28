import { verifyAuthTag, computeAuthTag, buildPreimage, validateConditions } from "./nip-oa.js";
import { schnorr } from "@noble/curves/secp256k1.js";

// Spec test vector, lifted verbatim from block/buzz crates/buzz-sdk/src/nip_oa.rs
const OWNER = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const AGENT = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const CONDITIONS = "kind=1&created_at<1713957000";
const SPEC_SIG = "8b7df2575caf0a108374f8471722b233c53f9ff827a8b0f91861966c3b9dd5cb2e189eae9f49d72187674c2f5bd244145e10ff86c9f257ffe65a1ee5f108b369";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { cond ? (pass++, console.log("  PASS", name)) : (fail++, console.log("  FAIL", name)); };
const throws = (name: string, fn: () => void) => { try { fn(); fail++; console.log("  FAIL", name, "(expected throw)"); } catch { pass++; console.log("  PASS", name); } };

console.log("\n[1] Preimage matches spec format");
ok("preimage", buildPreimage(AGENT, CONDITIONS) === `nostr:agent-auth:${AGENT}:${CONDITIONS}`);

console.log("\n[2] SPEC TEST VECTOR — verify Buzz's own known-good signature");
try {
  const owner = verifyAuthTag(["auth", OWNER, CONDITIONS, SPEC_SIG], AGENT);
  ok("spec signature verifies", owner === OWNER);
} catch (e) { fail++; console.log("  FAIL spec signature:", (e as Error).message); }

console.log("\n[3] Round-trip: sign then verify");
const sk = schnorr.utils.randomSecretKey();
const tag = computeAuthTag(sk, AGENT, "created_at>1000");
ok("round-trip verifies", verifyAuthTag(tag, AGENT) === tag[1]);

console.log("\n[4] Rejections");
throws("tampered signature", () => verifyAuthTag(["auth", OWNER, CONDITIONS, "0".repeat(128)], AGENT));
throws("wrong agent key", () => verifyAuthTag(["auth", OWNER, CONDITIONS, SPEC_SIG], "a".repeat(64)));
throws("self-attestation", () => verifyAuthTag(["auth", AGENT, "", SPEC_SIG], AGENT));
throws("wrong element count", () => verifyAuthTag(["auth", OWNER, CONDITIONS], AGENT));
throws("not 'auth' label", () => verifyAuthTag(["notauth", OWNER, CONDITIONS, SPEC_SIG], AGENT));

console.log("\n[5] Conditions grammar");
validateConditions(""); validateConditions("kind=1"); validateConditions("kind=1&created_at<5"); pass += 3;
console.log("  PASS valid forms accepted (3)");
throws("trailing &", () => validateConditions("kind=1&"));
throws("double &", () => validateConditions("kind=1&&kind=2"));
throws("leading zero", () => validateConditions("kind=01"));
throws("whitespace", () => validateConditions("kind=1 &kind=2"));
throws("kind out of range", () => validateConditions("kind=65536"));
throws("unknown clause", () => validateConditions("foo=1"));

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
