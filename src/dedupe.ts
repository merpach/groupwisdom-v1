/**
 * Recognising a finding we have already said.
 *
 * The engine re-derives the same conclusions every time it runs, and the only
 * defence was an exact lowercase title match. A model never writes the same
 * sentence twice, so nothing was ever caught: an independent review ran three
 * analyses over unchanged data and watched the wisdom count go 2 → 4 → 6, with
 * "JSON payloads cost 2.1x more memory than msgpack" and "JSON costs 2.1x more
 * memory than msgpack." stored as separate findings. That single defect inverts
 * the product: an assistant selling restraint that repeats itself is worse than
 * one that never promised restraint.
 *
 * Deliberately lexical rather than model-judged. A model call to ask "is this
 * the same?" costs money on every candidate, varies run to run, and would be
 * asking the same model that just restated itself to notice that it did. Token
 * overlap is free, deterministic, and testable against the exact pairs the
 * review found.
 *
 * The asymmetry that sets the threshold: a duplicate is annoying and visible,
 * while a suppressed finding is invisible and gone for good. So this is tuned
 * to catch restatements and let genuinely borderline things through, and every
 * suppression is recorded as a gate record so a wrong call can be found rather
 * than silently trusted.
 */

/** Words that carry no topic. Kept small on purpose: a long list starts eating signal. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "that", "this", "these", "those",
  "is", "are", "was", "were", "be", "been", "being", "it", "its", "as", "at", "by", "for", "from",
  "in", "into", "of", "on", "to", "with", "without", "not", "no", "so", "can", "could", "will",
  "would", "should", "may", "might", "has", "have", "had", "do", "does", "did", "more", "less",
  "now", "still", "also", "which", "who", "what", "when", "while", "there", "their", "them",
  "they", "we", "our", "you", "your", "he", "she", "his", "her", "one", "two", "both", "each",
]);

/**
 * Strip a word to a rough stem so "costs" and "cost", "switching" and "switch"
 * count as the same token. Crude by design — a real stemmer is a dependency and
 * the extra accuracy does not change which pairs match.
 */
function stem(w: string): string {
  if (/\d/.test(w)) return w;                        // never touch numbers or "2.1x"
  if (w.length <= 4) return w;
  return w
    .replace(/(ization|isation)$/, "ize")
    .replace(/(ing|edly|ed|es|s)$/, "")
    .replace(/(ility)$/, "le")
    .replace(/(iness|ness)$/, "");
}

/**
 * Content tokens of a piece of text.
 *
 * Numbers survive with their units attached ("2.1x", "41.3", "40%"), because two
 * findings quoting the same unusual measurement are almost always the same
 * finding, and that is the strongest cheap signal available.
 */
export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  const words = String(text ?? "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9.%×x\s'-]/g, " ")
    .split(/\s+/);
  for (const raw of words) {
    const w = raw.replace(/^[.'-]+|[.'-]+$/g, "");
    if (!w) continue;
    if (STOPWORDS.has(w)) continue;
    if (w.length < 3 && !/\d/.test(w)) continue;
    out.add(stem(w));
  }
  return out;
}

const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
};

/** Distinctive figures: "2.1x", "41.3", "40%". Shared ones are strong evidence. */
export function figures(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of String(text ?? "").matchAll(/\d+(?:\.\d+)?\s*(?:%|x|×)?/gi)) {
    const f = m[0].replace(/\s+/g, "").toLowerCase();
    if (f && f !== "1" && f !== "2") out.add(f);   // 1 and 2 are everywhere and mean nothing
  }
  return out;
}

export type Finding = { title?: string; body?: string };

/**
 * How alike two findings are, from 0 to 1.
 *
 * The title is weighted above the body because it is the claim; the body is
 * supporting detail and two unrelated findings about one project share plenty
 * of it. Quoting the same distinctive figure lifts the score, since a repeated
 * "2.1x" across two findings is rarely a coincidence.
 */
export function similarity(a: Finding, b: Finding): number {
  const ta = contentTokens(a.title ?? ""), tb = contentTokens(b.title ?? "");
  const ba = contentTokens(`${a.title ?? ""} ${a.body ?? ""}`);
  const bb = contentTokens(`${b.title ?? ""} ${b.body ?? ""}`);

  const base = 0.6 * jaccard(ta, tb) + 0.4 * jaccard(ba, bb);

  const fa = figures(`${a.title ?? ""} ${a.body ?? ""}`);
  const fb = figures(`${b.title ?? ""} ${b.body ?? ""}`);
  let sharedFigures = 0;
  for (const f of fa) if (fb.has(f)) sharedFigures++;
  const boost = sharedFigures && fa.size && fb.size ? 0.15 * (sharedFigures / Math.min(fa.size, fb.size)) : 0;

  return Math.min(1, base + boost);
}

/**
 * Tunable without a deploy, because the right value is an empirical question
 * that real traffic answers better than a test file. Raising it lets more
 * duplicates through; lowering it starts eating findings.
 */
export const DEDUPE_THRESHOLD = Number(process.env.GW_DEDUPE_THRESHOLD || 0.52);

/**
 * Below the threshold but close to it. Nothing is suppressed here — these are
 * recorded so that where the line actually belongs is answered by real findings
 * rather than by the handful of examples available while writing this. The
 * separation on those examples was only about 0.08 wide, which is too thin to
 * trust from invented prose.
 */
export const DEDUPE_WATCH_FLOOR = Number(process.env.GW_DEDUPE_WATCH || 0.3);

/**
 * The finding this candidate restates, if any. Exact title match still counts,
 * so nothing that was caught before slips through now.
 */
export function findRestatement<T extends Finding & { id?: string }>(
  candidate: Finding,
  existing: T[],
  threshold = DEDUPE_THRESHOLD,
): { of: T; score: number } | null {
  const nearest = nearestFinding(candidate, existing);
  return nearest && nearest.score >= threshold ? nearest : null;
}

/** The closest existing finding and its score, whatever the threshold. */
export function nearestFinding<T extends Finding & { id?: string }>(
  candidate: Finding,
  existing: T[],
): { of: T; score: number } | null {
  const title = (candidate.title ?? "").trim().toLowerCase();
  let best: { of: T; score: number } | null = null;
  for (const e of existing) {
    if (title && (e.title ?? "").trim().toLowerCase() === title) return { of: e, score: 1 };
    const score = similarity(candidate, e);
    if (!best || score > best.score) best = { of: e, score };
  }
  return best;
}
