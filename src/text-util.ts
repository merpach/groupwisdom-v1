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
