/**
 * Standalone entry point for the Buzz adapter — run with `npm run buzz`.
 *
 * This is deliberately separate from the Express server (src/index.ts) so the
 * live app is never affected. It only starts when BUZZ_* env vars are present.
 * It talks to GroupWisdom over the real public /v1 API, authenticated with your
 * personal API key — the same way any external integration would.
 *
 * Required env:
 *   BUZZ_RELAY_URL        wss://your-community.communities.buzz.xyz  (or ws://localhost:3000)
 *   BUZZ_PRIVATE_KEY      nsec1... or 64-char hex — the agent's Nostr identity
 *   GROUPWISDOM_API_KEY   gw_...  — your personal GroupWisdom API key
 * Optional:
 *   GROUPWISDOM_BASE_URL  defaults to the production GroupWisdom API
 *   BUZZ_CHANNELS         comma-separated channel UUIDs to watch immediately
 *                         (otherwise every channel the identity can see is auto-discovered)
 *   BUZZ_DRY_RUN          1/true — connect and log, but never ingest or post
 */
import { startBuzzAdapter } from "./adapters/buzz.js";

const relayUrl = process.env.BUZZ_RELAY_URL;
const privateKey = process.env.BUZZ_PRIVATE_KEY;
const groupwisdomApiKey = process.env.GROUPWISDOM_API_KEY;

if (!relayUrl || !privateKey || !groupwisdomApiKey) {
  console.error(
    "Buzz adapter needs BUZZ_RELAY_URL, BUZZ_PRIVATE_KEY, and GROUPWISDOM_API_KEY.\n" +
    "  1. Get a Buzz relay URL and invite/claim a Nostr identity into it.\n" +
    "  2. Get your GroupWisdom personal API key (gw_...) from your account.\n" +
    "  3. Export BUZZ_RELAY_URL, BUZZ_PRIVATE_KEY, GROUPWISDOM_API_KEY, then re-run `npm run buzz`.",
  );
  process.exit(1);
}

const channels = (process.env.BUZZ_CHANNELS ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const dryRun = /^(1|true|yes)$/i.test(process.env.BUZZ_DRY_RUN ?? "");
if (dryRun) console.log("[buzz] DRY RUN — will connect and log, but never ingest or post wisdom back");

const handle = startBuzzAdapter({
  relayUrl,
  privateKey,
  groupwisdomApiKey,
  groupwisdomBaseUrl: process.env.GROUPWISDOM_BASE_URL,
  channels,
  dryRun,
});

process.on("SIGINT", () => { handle.stop(); process.exit(0); });
process.on("SIGTERM", () => { handle.stop(); process.exit(0); });
