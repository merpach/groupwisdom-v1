/**
 * Fixed-window rate limiting, in process. No dependency and no store to run:
 * a single-instance deployment only needs a Map, and the failure mode of a
 * restart (counters reset) errs open, which is the right direction for a
 * limiter that exists to stop brute force and runaway loops, not to bill.
 */
import type { Request, Response, NextFunction } from "express";

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

// Sweep dead buckets so the map cannot grow without bound under key churn.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60_000).unref();

/**
 * `keyFn` decides what is being limited: an IP for anonymous auth attempts, an
 * API key for the /v1 surface. Returning null skips limiting for that request.
 */
export function rateLimit(opts: {
  windowMs: number;
  max: number;
  name: string;
  keyFn?: (req: Request) => string | null;
  /**
   * Count responses of 400 and above instead of requests. For an endpoint
   * whose legitimate traffic all arrives from one upstream: every customer's
   * Teams messages come from Microsoft's shared addresses, so a limit on
   * requests per address would slow real customers together, while a limit
   * on rejections never touches a caller whose token verifies.
   */
  failuresOnly?: boolean;
}) {
  const keyFn = opts.keyFn ?? ((req: Request) => req.ip ?? "unknown");
  const bucket = (id: string, now: number) => {
    let b = buckets.get(id);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(id, b);
    }
    return b;
  };
  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyFn(req);
    if (key === null) return next();
    const id = `${opts.name}:${key}`;
    const now = Date.now();
    const b = bucket(id, now);
    if (!opts.failuresOnly) b.count++;
    const remaining = Math.max(0, opts.max - b.count);
    res.setHeader("X-RateLimit-Limit", String(opts.max));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    // Counting failures, the bucket fills after the fact, so a full bucket
    // refuses the next request rather than this one.
    if (opts.failuresOnly ? b.count >= opts.max : b.count > opts.max) {
      res.setHeader("Retry-After", String(Math.ceil((b.resetAt - now) / 1000)));
      return res.status(429).json({ error: "Too many requests. Slow down and retry shortly." });
    }
    if (opts.failuresOnly) {
      res.on("finish", () => { if (res.statusCode >= 400) bucket(id, Date.now()).count++; });
    }
    next();
  };
}

/** Limit by API key when one is presented, by IP otherwise. */
export function apiKeyOrIp(req: Request): string {
  const key = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  return key ? "k:" + key.slice(0, 24) : "ip:" + (req.ip ?? "unknown");
}
