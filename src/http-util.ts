/**
 * Small request helpers shared by the sign-in flows. They live here because
 * both flows need them and duplicated security logic drifts: a fix applied to
 * one copy and not the other is worse than no fix, since it reads as covered.
 */

/**
 * Only same-origin paths, so a ?next= parameter cannot become an open redirect.
 *
 * Non-strings are refused outright: a repeated query parameter arrives as an
 * array, and String(["/a","/b"]) is "/a,/b", which would otherwise slip past
 * the pattern because a comma is legal in a path.
 */
export function safeNext(next: unknown, fallback = "/buzz"): string {
  if (typeof next !== "string") return fallback;
  return /^\/[A-Za-z0-9\-._~/?#[\]@!$&'()*+,;=]*$/.test(next) && !next.startsWith("//") ? next : fallback;
}

/**
 * The public origin of this request, so one build serves every domain without
 * a hardcoded URL. Reading the forwarded headers is safe for building a
 * redirect_uri because both providers refuse any callback URL that is not
 * registered with them, so a forged Host cannot send a code somewhere new.
 */
export function requestOrigin(req: any): string {
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string)?.split(",")[0] || req.get("host");
  return `${proto}://${host}`;
}
