/**
 * A credential for the server's own adapters, and for nothing else.
 *
 * Message text is write-only to every customer credential: once a message is
 * stored, no personal key, project key or signed-in session can read its title,
 * content or link back, so a stolen key cannot be used to read a team's chat.
 *
 * The hosted Buzz adapters are the one reader the product needs. They run
 * inside this server, call the API over loopback with their owner's key, and
 * quote a few words of a message beside each fact in their memory reply, the
 * same as the Teams and Slack adapters do in-process. This token lets them,
 * and only them.
 *
 * It is drawn at boot and held only in this process's memory: never stored,
 * never logged, never sent anywhere but to this server over loopback. It is
 * honoured only on a connection that comes from this machine, so it cannot be
 * paired with a stolen customer key from outside.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

export const INTERNAL_HEADER = "x-groupwisdom-internal";

const TOKEN = randomBytes(32).toString("hex");

export const internalToken = (): string => TOKEN;

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isInternalCaller(req: { headers: Record<string, unknown>; socket?: { remoteAddress?: string } }): boolean {
  if (!LOOPBACK.has(String(req.socket?.remoteAddress ?? ""))) return false;
  const got = Buffer.from(String(req.headers[INTERNAL_HEADER] ?? ""));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}
