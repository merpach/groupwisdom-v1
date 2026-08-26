/**
 * Text helpers shared by the server and the standalone Buzz adapter. Kept in
 * its own module with no dependencies, because the adapter is meant to run on
 * its own and must not pull in the engine or the database to borrow a string
 * function.
 */

/**
 * Truncate to `max` characters without splitting a character in half.
 *
 * JavaScript strings are UTF-16, so `"🚀".length` is 2 and an ordinary slice
 * can land between the two halves of an emoji. The result is a lone surrogate:
 * invalid text that renders as a tofu box, and that we would then store,
 * encrypt, and hand to a model. Iterating with the spread operator walks whole
 * code points, so a cut always falls between characters.
 *
 * A long ZWJ sequence (👨‍👩‍👧‍👦) can still be cut into its component emoji, which
 * degrades to something readable rather than something broken.
 */
export function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;          // fast path: no astral characters possible
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max).join("");
}

/**
 * Close every structure a cut-off reply left open, discarding a trailing key
 * whose value never arrived. Returns null when nothing was left open.
 */
export function closeOpenJson(s: string): string | null {
  const close: string[] = [];
  let inString = false, escaped = false;
  for (const c of s) {
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") close.push("}");
    else if (c === "[") close.push("]");
    else if (c === "}" || c === "]") close.pop();
  }
  if (!close.length) return null;
  let out = inString ? s + '"' : s;                        // finish the value it was mid-way through
  // A trailing string is a dangling key only inside an object. Inside an array
  // it is a finished element, and dropping it would discard real content.
  if (close[close.length - 1] === "}") {
    out = out.replace(/([,{])\s*"[^"]*"\s*:?\s*$/, (_m, d) => (d === "{" ? "{" : ""));
  }
  out = out.replace(/,\s*$/, "");                          // a separator with nothing after it
  while (close.length) out += close.pop();
  return out;
}

/**
 * Pull the JSON object out of a model reply.
 *
 * Slicing between the first "{" and the last "}" looks safe until the reply is
 * cut off at max_tokens: there is no closing brace, lastIndexOf returns -1, the
 * slice collapses to "", and JSON.parse dies with "Unexpected end of JSON
 * input" — taking the whole batch with it. That bit hardest at the scout, whose
 * answer is only long enough to truncate when it has actually found something,
 * so the engine went quiet at exactly the moments it had something to say.
 * Keep the fields that did complete, and when there is nothing to keep, say so
 * in terms that name the cause.
 */
export function parseModelJson(raw: string, what: string): any {
  const start = raw.indexOf("{");
  if (start === -1) throw new Error(`${what}: reply contained no JSON object`);
  const end = raw.lastIndexOf("}");
  if (end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* fall through and repair */ }
  }
  const repaired = closeOpenJson(raw.slice(start));
  if (repaired) {
    try { return JSON.parse(repaired); } catch { /* fall through and report */ }
  }
  throw new Error(`${what}: reply was cut off mid-JSON and could not be repaired (${raw.length} chars)`);
}
