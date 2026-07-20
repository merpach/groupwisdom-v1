/**
 * The insight engine.
 * Looks at everything the group has shared and surfaces:
 * convergences, opportunities, tensions, patterns, directions, decisions.
 * Also maintains the group's living knowledge-base markdown document.
 *
 * Uses the Claude API when ANTHROPIC_API_KEY is set; otherwise falls back to
 * a deterministic mock so the whole product works offline.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  listItems, listItemsWithMembers, listMembers, listInsights, addInsight, setInsightStatus,
  setKnowledgeDoc, getGroup, setProjectSummary, setUserContext, listUserContexts,
  getMemberByUserId, listItemsByMember, recordUsage, isGroupOverBudget, getGroupEngine,
  type Item, type Insight,
} from "./db.js";

const MODEL = process.env.GW_MODEL || "claude-haiku-4-5-20251001"; // set GW_MODEL=claude-fable-5 to upgrade
const SUMMARY_MODEL = "claude-haiku-4-5-20251001";
const KINDS = ["convergence", "opportunity", "tension", "pattern", "direction", "decision"];

const running = new Set<string>();

// ── Incremental Wisdom (Haiku, runs on every item add) ───────────────────────

const pendingAnalysis = new Map<string, { items: Item[]; timer: ReturnType<typeof setTimeout> }>();

/** Cancel any pending incremental analysis for a group (call before explicit analyzeGroup). */
export function cancelPendingAnalysis(groupId: string): void {
  const existing = pendingAnalysis.get(groupId);
  if (existing) {
    clearTimeout(existing.timer);
    pendingAnalysis.delete(groupId);
  }
}

/** Queue an incremental Wisdom pass. Debounces 3s so burst adds are batched. */
export function queueIncrementalAnalysis(groupId: string, item: Item, onComplete?: (insights: Insight[]) => void) {
  const existing = pendingAnalysis.get(groupId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.items.push(item);
  } else {
    pendingAnalysis.set(groupId, { items: [item], timer: null! });
  }
  const pending = pendingAnalysis.get(groupId)!;
  pending.timer = setTimeout(async () => {
    const items = pending.items;
    pendingAnalysis.delete(groupId);
    const [newInsights] = await Promise.all([
      runIncrementalWisdom(groupId, items).catch(err => { console.error("[wisdom]", err.message); return [] as Insight[]; }),
      checkContextOverlapForWisdom(groupId, items).catch(err => console.error("[overlap]", err.message)),
    ]);
    onComplete?.(newInsights ?? []);
  }, 3000);
}

async function runIncrementalWisdom(groupId: string, newItems: Item[]): Promise<Insight[]> {
  const group = getGroup(groupId);
  if (!group) return [];
  const existing = listInsights(groupId);
  const allWithMembers = listItemsWithMembers(groupId);
  const recent = allWithMembers.filter(i => !newItems.some(n => n.id === i.id)).slice(0, 15);

  // Build a map of member_id → name for new items (they come in as plain Items)
  const memberNames = new Map(allWithMembers.filter(i => i.member_name).map(i => [i.id, i.member_name!]));

  const fmt = (i: Item & { member_name?: string | null }) => {
    const by = i.member_name ? ` [by ${i.member_name}]` : "";
    return `[${i.type}]${by} "${i.title}"${i.url ? ` (${i.url})` : ""} — ${i.content?.slice(0, 120) || ""}`;
  };

  const newText = newItems.map(i => fmt({ ...i, member_name: memberNames.get(i.id) ?? null })).join("\n");
  const recentText = recent.map(i => fmt(i)).join("\n") || "(none)";
  const existingText = existing.map(i => `[${i.id}] [${i.kind}] ${i.title}: ${i.body}`).join("\n") || "(none)";

  // Detect contributor overlap before calling Claude — flag if new items share topics with items from different contributors
  const newContributors = new Set(newItems.map(i => memberNames.get(i.id)).filter(Boolean));
  const otherContributorItems = recent.filter(i => i.member_name && !newContributors.has(i.member_name));
  const overlapHint = otherContributorItems.length
    ? `\nPay special attention to overlap: new items are from ${[...newContributors].join(", ")}. Other contributors already in the project: ${[...new Set(otherContributorItems.map(i => i.member_name))].join(", ")}. If topics overlap across contributors, surface that explicitly — name both contributors in the insight body.`
    : "";

  if (!process.env.ANTHROPIC_API_KEY) {
    return []; // no mock for incremental — just skip
  }

  if (isGroupOverBudget(groupId)) {
    console.warn(`[wisdom] group ${groupId} over budget — skipping analysis`);
    return [];
  }

  const client = new Anthropic();
  const msg = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 700,
    messages: [{
      role: "user",
      content: `You are the Wisdom engine for a shared project called "${group.name}".
Members: ${listMembers(groupId).map(m => m.name).join(", ") || "unknown"}

New item${newItems.length > 1 ? "s" : ""} just added:
${newText}

Recent project items with contributor names (context):
${recentText}

Current wisdom (do not repeat; flag any now outdated):
${existingText}
${overlapHint}

Generate 1-2 insights. There is always something worth surfacing when multiple contributors share related data.
Keep each body to 1-2 short sentences, maximum 25 words. Be direct — no preamble, no "this suggests", no qualifiers.
When items come from multiple contributors on the same topic, always surface that as a pattern — name the contributors explicitly.
Also list IDs of any existing insights now stale, resolved, or superseded.

Respond ONLY with valid JSON:
{"new":[{"kind":"...","title":"...","body":"..."}],"dismiss":["id1"]}`,
    }],
  });
  recordUsage(groupId, SUMMARY_MODEL, msg.usage.input_tokens, msg.usage.output_tokens, "incremental_wisdom");

  const raw = msg.content.filter(b => b.type === "text").map(b => (b as any).text).join("");
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  let result: { new: Array<{ kind: string; title: string; body: string }>; dismiss: string[] };
  try { result = JSON.parse(json); } catch { return []; }

  const created: Insight[] = [];
  for (const ins of (result.new ?? [])) {
    if (!KINDS.includes(ins.kind)) continue;
    if (existing.some(e => e.title.toLowerCase() === ins.title.toLowerCase())) continue;
    const saved = addInsight(groupId, ins.kind, ins.title, ins.body);
    setInsightStatus(saved.id, "acknowledged"); // auto-accept live insights
    created.push({ ...saved, status: "acknowledged" });
  }
  for (const id of (result.dismiss ?? [])) {
    if (existing.some(e => e.id === id)) setInsightStatus(id, "dismissed");
  }

  return created;
}

export type ProposedInsight = { kind: string; title: string; body: string };

/** Preview mode: run the engine but don't save anything. Returns proposed insights for user review. */
export async function previewAnalysis(groupId: string): Promise<ProposedInsight[]> {
  const group = getGroup(groupId);
  if (!group) return [];
  const items = listItems(groupId);
  if (items.length === 0) return [];
  const members = listMembers(groupId);
  const existing = listInsights(groupId);

  const engine = getGroupEngine(groupId);
  const result = engine === "muse-spark" && process.env.META_MODEL_API_KEY
    ? await analyzeWithMuseSpark(groupId, group.name, items, members.map(m => `${m.name} (${m.role})`), existing)
    : process.env.ANTHROPIC_API_KEY
      ? await analyzeWithClaude(groupId, group.name, items, members.map(m => `${m.name} (${m.role})`), existing)
      : analyzeMock(group.name, items, existing);

  return result.insights.filter(ins =>
    KINDS.includes(ins.kind) &&
    !existing.some(e => e.title.toLowerCase() === ins.title.toLowerCase())
  );
}

/** Save a single accepted insight and update the knowledge doc. */
export async function acceptInsight(groupId: string, kind: string, title: string, body: string): Promise<Insight> {
  const saved = addInsight(groupId, kind, title, body);
  // also refresh knowledge doc in background
  analyzeGroup(groupId).catch(() => {});
  return saved;
}

export async function analyzeGroup(groupId: string): Promise<Insight[]> {
  if (running.has(groupId)) return [];
  running.add(groupId);
  try {
    const group = getGroup(groupId);
    if (!group) return [];
    const items = listItemsWithMembers(groupId);
    if (items.length === 0) return [];
    const members = listMembers(groupId);
    const existing = listInsights(groupId);

    if (process.env.ANTHROPIC_API_KEY && isGroupOverBudget(groupId)) {
      console.warn(`[analyze] group ${groupId} over budget — skipping`);
      return [];
    }

    const engine = getGroupEngine(groupId);
    const result = engine === "muse-spark" && process.env.META_MODEL_API_KEY
      ? await analyzeWithMuseSpark(groupId, group.name, items, members.map(m => `${m.name}${m.role ? ` (${m.role})` : ""}`), existing)
      : process.env.ANTHROPIC_API_KEY
        ? await analyzeWithClaude(groupId, group.name, items, members.map(m => `${m.name}${m.role ? ` (${m.role})` : ""}`), existing)
        : analyzeMock(group.name, items, existing);

    // Metacognitive second pass — filters and annotates candidate insights
    const candidates = result.insights.filter(ins =>
      KINDS.includes(ins.kind) &&
      !existing.some(e => e.title.toLowerCase() === ins.title.toLowerCase())
    );
    const annotated = candidates.length > 0
      ? await metacognitivePass(candidates, group.name, members.map(m => m.name), items.length, engine, groupId)
      : [];

    const suppressed = annotated.filter(ins => !ins.keep);
    if (suppressed.length) {
      console.log(`[metacognitive] suppressed ${suppressed.length} weak insight(s) for group ${groupId}:`, suppressed.map(ins => `"${ins.title}" (confidence: ${ins.confidence})`).join(", "));
    }

    const created: Insight[] = [];
    for (const ins of annotated) {
      if (!ins.keep) continue;
      const title = ins.revised_title ?? ins.title;
      const body = ins.revised_body ?? ins.body;
      if (ins.revised_title) console.log(`[metacognitive] revised title for "${ins.title}" → "${ins.revised_title}"`);
      created.push(addInsight(groupId, ins.kind, title, body, {
        confidence: ins.confidence,
        caveat: ins.caveat ?? undefined,
        do_next: ins.do_next ?? undefined,
        missing_voice: ins.missing_voice ?? undefined,
      }));
    }
    if (result.knowledge_markdown) setKnowledgeDoc(groupId, result.knowledge_markdown);
    return created;
  } finally {
    running.delete(groupId);
  }
}

type EngineResult = {
  insights: Array<{ kind: string; title: string; body: string }>;
  knowledge_markdown?: string;
};

async function analyzeWithClaude(
  groupId: string, groupName: string, items: (Item & { member_name?: string | null })[], members: string[], existing: Insight[],
): Promise<EngineResult> {
  const client = new Anthropic();
  const itemsText = items
    .map(i => `- [${i.type}]${i.member_name ? ` [by ${i.member_name}]` : ""} "${i.title}" ${i.url ? `(${i.url}) ` : ""}— ${i.content}`.trim())
    .join("\n");
  const existingText = existing.map(e => `- [${e.kind}] ${e.title}`).join("\n") || "(none)";

  const prompt = `You are the GroupWisdom insight engine: the shared brain of a group called "${groupName}".
Members: ${members.join(", ") || "(unknown)"}

Everything the group has shared (newest first, with contributor name where known):
${itemsText}

Insights already surfaced (do NOT repeat these):
${existingText}

Tasks:
1. Surface NEW insights only where there is real signal. Allowed kinds:
   - convergence: two members arrived at the same finding from different angles — name both
   - opportunity: something the group's existing research is pointing toward that nobody has pursued yet
   - tension: two perspectives worth bringing together to reach a stronger conclusion
   - pattern: a theme emerging across multiple members' contributions
   - direction: the natural next question the group's collective work is building toward
   - decision: something the group has collectively arrived at, and what led to it
   0-4 insights. Quality over quantity. Each: short title + 1-2 sentence body, max 25 words. Direct, no qualifiers. Frame everything in terms of what the group is building together, not what is missing.
   When two different contributors are researching overlapping topics, always surface that as a convergence — name both contributors explicitly, e.g. "Sarah and James are both building toward X from different angles."
2. Rewrite the group's living knowledge-base document as clean markdown:
   a title, a one-line italic summary, then sections that organize what is known, noting who contributed key findings.
   Include open questions. Keep it under 400 words.

Respond with ONLY valid JSON:
{"insights":[{"kind":"...","title":"...","body":"..."}],"knowledge_markdown":"..."}`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    messages: [{ role: "user", content: prompt }],
  });
  recordUsage(groupId, MODEL, msg.usage.input_tokens, msg.usage.output_tokens, "full_analysis");
  const text = msg.content.filter(b => b.type === "text").map(b => (b as any).text).join("");
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(json) as EngineResult;
}

type MetaInsight = {
  kind: string; title: string; body: string;
  confidence: string; caveat: string | null; do_next: string | null; missing_voice: string | null; keep: boolean;
  revised_title: string | null; revised_body: string | null;
};

async function metacognitivePass(
  candidates: Array<{ kind: string; title: string; body: string }>,
  groupName: string,
  memberNames: string[],
  itemCount: number,
  engine: string,
  groupId?: string,
): Promise<MetaInsight[]> {
  const prompt = `You are a metacognitive evaluator for a group intelligence engine called GroupWisdom.
A first-pass AI has generated candidate insights from the shared data of a group called "${groupName}".

Group stats: ${memberNames.length} contributors (${memberNames.join(", ")}), ${itemCount} items total.

Candidate insights:
${candidates.map((ins, i) => `[${i}] (${ins.kind}) "${ins.title}": ${ins.body}`).join("\n")}

For each candidate, evaluate:
- confidence: "high" (3+ independent data points), "medium" (2 points), or "low" (1 point or inferred)
- caveat: one short sentence on what would change this conclusion, or null if solid
- do_next: one concrete action the group should take, or null if it is purely observational
- missing_voice: name of a specific contributor whose input would change this, or null
- keep: false if the insight is too speculative, too thin, or not yet ready to surface — otherwise true
- revised_title: a sharper version of the title if the original is vague, buries the finding, or understates the evidence — otherwise null. Must be under 12 words.
- revised_body: a revised body if you can materially improve clarity, precision, or incorporate the caveat naturally — otherwise null. Keep it to 1-2 sentences.

Only revise when you can genuinely improve the text. Null means the original is good enough.
Be strict on keep. It is better to suppress a weak insight than to deliver noise.

Respond with ONLY valid JSON — an array matching the candidate order:
[{"id":0,"confidence":"high","caveat":null,"do_next":"...","missing_voice":null,"keep":true,"revised_title":null,"revised_body":null},...]`;

  try {
    let text = "";
    if (engine === "muse-spark" && process.env.META_MODEL_API_KEY) {
      const res = await fetch("https://api.meta.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${process.env.META_MODEL_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "muse-spark-1.1", messages: [{ role: "user", content: prompt }], max_tokens: 1200 }),
      });
      const data = await res.json() as any;
      text = data.choices?.[0]?.message?.content ?? "";
    } else if (process.env.ANTHROPIC_API_KEY) {
      const client = new Anthropic();
      const msg = await client.messages.create({
        model: SUMMARY_MODEL, // Haiku — fast and cheap for structured evaluation
        max_tokens: 1200,
        messages: [{ role: "user", content: prompt }],
      });
      recordUsage(groupId ?? "meta", SUMMARY_MODEL, msg.usage.input_tokens, msg.usage.output_tokens, "metacognitive_pass");
      text = msg.content.filter(b => b.type === "text").map(b => (b as any).text).join("");
    } else {
      // No API — pass through all candidates with default annotations
      return candidates.map(c => ({ ...c, confidence: "medium", caveat: null, do_next: null, missing_voice: null, keep: true, revised_title: null, revised_body: null }));
    }

    const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
    const results = JSON.parse(json) as Array<{ id: number; confidence: string; caveat: string | null; do_next: string | null; missing_voice: string | null; keep: boolean; revised_title: string | null; revised_body: string | null }>;

    return candidates.map((c, i) => {
      const r = results.find(x => x.id === i);
      return {
        ...c,
        confidence: r?.confidence ?? "medium",
        caveat: r?.caveat ?? null,
        do_next: r?.do_next ?? null,
        missing_voice: r?.missing_voice ?? null,
        keep: r?.keep ?? true,
        revised_title: r?.revised_title ?? null,
        revised_body: r?.revised_body ?? null,
      };
    });
  } catch (err) {
    console.error("[metacognitive]", (err as Error).message);
    return candidates.map(c => ({ ...c, confidence: "medium", caveat: null, do_next: null, missing_voice: null, keep: true, revised_title: null, revised_body: null }));
  }
}

async function analyzeWithMuseSpark(
  groupId: string, groupName: string, items: (Item & { member_name?: string | null })[], members: string[], existing: Insight[],
): Promise<EngineResult> {
  const apiKey = process.env.META_MODEL_API_KEY;
  if (!apiKey) throw new Error("META_MODEL_API_KEY not set");

  const itemsText = items
    .map(i => `- [${i.type}]${i.member_name ? ` [by ${i.member_name}]` : ""} "${i.title}" ${i.url ? `(${i.url}) ` : ""}— ${i.content}`.trim())
    .join("\n");
  const existingText = existing.map(e => `- [${e.kind}] ${e.title}`).join("\n") || "(none)";

  const prompt = `You are the GroupWisdom insight engine: the shared brain of a group called "${groupName}".
Members: ${members.join(", ") || "(unknown)"}

Everything the group has shared (newest first, with contributor name where known):
${itemsText}

Insights already surfaced (do NOT repeat these):
${existingText}

Tasks:
1. Surface NEW insights only where there is real signal. Allowed kinds:
   - convergence: two members arrived at the same finding from different angles — name both
   - opportunity: something the group's existing research is pointing toward that nobody has pursued yet
   - tension: two perspectives worth bringing together to reach a stronger conclusion
   - pattern: a theme emerging across multiple members' contributions
   - direction: the natural next question the group's collective work is building toward
   - decision: something the group has collectively arrived at, and what led to it
   0-4 insights. Quality over quantity. Each: short title + 1-2 sentence body, max 25 words. Direct, no qualifiers. Frame everything in terms of what the group is building together, not what is missing.
   When two different contributors are researching overlapping topics, always surface that as a convergence — name both contributors explicitly.
2. Rewrite the group's living knowledge-base document as clean markdown:
   a title, a one-line italic summary, then sections that organize what is known, noting who contributed key findings.
   Include open questions. Keep it under 400 words.

Respond with ONLY valid JSON:
{"insights":[{"kind":"...","title":"...","body":"..."}],"knowledge_markdown":"..."}`;

  const res = await fetch("https://api.meta.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "muse-spark-1.1",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 3000,
    }),
  });
  if (!res.ok) throw new Error(`Muse Spark error ${res.status}: ${await res.text()}`);
  const data = await res.json() as any;
  const text = data.choices?.[0]?.message?.content ?? "";
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(json) as EngineResult;
}

/** Deterministic fallback: simple heuristics so the demo works with no API key. */
function analyzeMock(groupName: string, items: Item[], existing: Insight[]): EngineResult {
  const insights: EngineResult["insights"] = [];
  const has = (t: string) => existing.some(e => e.title === t) || insights.some(i => i.title === t);

  // pattern: 3+ items share a significant word
  const counts = new Map<string, Item[]>();
  for (const it of items) {
    for (const w of new Set((it.title + " " + it.content).toLowerCase().match(/[a-zà-ö]{5,}/g) ?? [])) {
      counts.set(w, [...(counts.get(w) ?? []), it]);
    }
  }
  const top = [...counts.entries()].filter(([, v]) => v.length >= 3).sort((a, b) => b[1].length - a[1].length)[0];
  if (top) {
    const t = `The group keeps coming back to "${top[0]}"`;
    if (!has(t)) insights.push({
      kind: "pattern" as const, title: t,
      body: `${top[1].length} of ${items.length} shared items mention "${top[0]}". A shared focus is emerging that no one has named yet.`,
    });
  }

  // convergence: newest item shares a word with an older one
  const newest = items[0];
  if (newest && items.length >= 2) {
    const words = new Set((newest.title + " " + newest.content).toLowerCase().match(/[a-zà-ö]{6,}/g) ?? []);
    const other = items.slice(1).find(it =>
      [...words].some(w => (it.title + " " + it.content).toLowerCase().includes(w)));
    if (other) {
      const t = `"${newest.title}" relates to "${other.title}"`;
      if (!has(t)) insights.push({
        kind: "convergence" as const, title: t,
        body: "Two items shared by different moments overlap. Worth looking at them side by side.",
      });
    }
  }

  // opportunity: everything is the same type — broader input could strengthen the work
  const types = new Set(items.map(i => i.type));
  if (items.length >= 4 && types.size === 1) {
    const t = `The group's contributions are all ${[...types][0]}s`;
    if (!has(t)) insights.push({
      kind: "opportunity" as const, title: t,
      body: "Adding files, links, or raw thoughts alongside could deepen what the group is building together.",
    });
  }

  // direction: nudge toward capturing decisions once enough material exists
  if (items.length >= 5) {
    const t = "The group is building toward a shared conclusion";
    if (!has(t)) insights.push({
      kind: "direction" as const, title: t,
      body: "A lot has been contributed — capturing what the group has collectively arrived at would strengthen the work.",
    });
  }

  // knowledge doc
  const byType = (ty: string) => items.filter(i => i.type === ty);
  const section = (h: string, list: Item[]) => list.length
    ? `\n## ${h}\n\n${list.map(i => `- **${i.title}**${i.url ? ` — ${i.url}` : ""}${i.content ? ` — ${i.content}` : ""}`).join("\n")}\n` : "";
  const knowledge_markdown =
    `# ${groupName}\n\n_Auto-written by the GroupWisdom engine from ${items.length} shared item${items.length === 1 ? "" : "s"}._\n` +
    section("Links", byType("link")) +
    section("Notes", byType("note")) +
    section("Files", byType("file")) +
    section("Thoughts", byType("thought")) +
    `\n## Open questions\n\n- What has the group decided so far?\n`;

  return { insights, knowledge_markdown };
}

/**
 * Generates a short hidden summary of a project using Haiku (cheap).
 * Called async after every item add — never blocks the user.
 * Used by get_project_index in the MCP to give Claude a semantic trigger map.
 */
export async function updateProjectSummary(groupId: string): Promise<void> {
  const group = getGroup(groupId);
  if (!group) return;
  const items = listItems(groupId);
  if (items.length === 0) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // mock: just use item titles as the summary
    const summary = `Project about: ${items.slice(0, 5).map(i => i.title).join(", ")}.`;
    setProjectSummary(groupId, summary);
    return;
  }

  const client = new Anthropic({ apiKey });
  const itemList = items.slice(0, 40)
    .map(i => `- ${i.title}${i.content ? `: ${i.content.slice(0, 80)}` : ""}`)
    .join("\n");

  const msg = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 200,
    messages: [{
      role: "user",
      content: `You are indexing a shared knowledge project called "${group.name}" for semantic search.
Write a 2-3 sentence summary that captures the key topics, people, places, dates, and decisions in this project.
Be specific — include proper nouns, locations, names. This will be used to detect when someone mentions this project in conversation.

Items shared so far:
${itemList}

Reply with only the summary, no preamble.`,
    }],
  });
  recordUsage(groupId, SUMMARY_MODEL, msg.usage.input_tokens, msg.usage.output_tokens, "project_summary");

  const summary = msg.content.filter(b => b.type === "text").map(b => (b as any).text).join("").trim();
  if (summary) setProjectSummary(groupId, summary);
}

/**
 * Generates a hidden per-user research summary using Haiku.
 * Triggered automatically whenever a user saves something via MCP.
 * Stored in user_context and shared with teammates only when relevant.
 */
export async function updateUserContext(userId: string, groupId: string): Promise<void> {
  const group = getGroup(groupId);
  if (!group) return;
  const member = getMemberByUserId(groupId, userId);
  if (!member) return;
  const items = listItemsByMember(groupId, member.id);
  if (!items.length) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const summary = `${member.name} has been researching: ${items.slice(0, 5).map(i => i.title).join(", ")}.`;
    setUserContext(userId, groupId, summary);
    return;
  }

  const client = new Anthropic({ apiKey });
  const itemList = items.slice(0, 20)
    .map(i => `- ${i.title}${i.content ? `: ${i.content.slice(0, 100)}` : ""}`)
    .join("\n");

  const msg = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 150,
    messages: [{
      role: "user",
      content: `Summarize what "${member.name}" has been contributing to a shared project called "${group.name}".
Write 2-3 sentences describing the topics, themes, or areas they have been researching or saving.
Be specific. This summary will be shared with teammates to help them see if their research overlaps.

Their contributions:
${itemList}

Reply with only the summary, no preamble.`,
    }],
  });
  recordUsage(groupId, SUMMARY_MODEL, msg.usage.input_tokens, msg.usage.output_tokens, "user_context");

  const summary = msg.content.filter(b => b.type === "text").map(b => (b as any).text).join("").trim();
  if (summary) setUserContext(userId, groupId, summary);
}

export type OverlapResult = {
  hasOverlap: boolean;
  overlaps: Array<{ teammate: string; summary: string }>;
};

/**
 * Actively checks if the current user's research overlaps with any teammate.
 * Called by get_group_context so Claude gets a direct signal rather than raw summaries.
 */
export async function detectContributorOverlap(
  userId: string,
  groupId: string,
  currentTopic?: string, // what the user is currently asking about in this conversation
): Promise<OverlapResult> {
  const allContexts = listUserContexts(groupId);
  const mine = allContexts.find(c => c.user_id === userId);
  const teammates = allContexts.filter(c => c.user_id !== userId);

  if (!teammates.length) return { hasOverlap: false, overlaps: [] };
  if (!mine?.summary && !currentTopic) return { hasOverlap: false, overlaps: [] };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { hasOverlap: false, overlaps: [] };

  const client = new Anthropic({ apiKey });
  const userFocus = currentTopic
    ? `Currently asking about: "${currentTopic}"\nRecent research summary: ${mine?.summary || "(none yet)"}`
    : mine!.summary;

  const msg = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 400,
    messages: [{
      role: "user",
      content: `You are checking for research overlap on a team.

Current user's focus:
${userFocus}

Teammates' research summaries:
${teammates.map(t => `- ${t.name}: ${t.summary}`).join("\n")}

For each teammate whose research meaningfully overlaps with the current user's focus, explain the overlap in one sentence.
Only flag genuine topical overlap — not vague similarity.

Respond ONLY with valid JSON:
{"overlaps":[{"teammate":"name","summary":"one sentence describing the overlap"}]}
If no overlap, respond: {"overlaps":[]}`,
    }],
  });
  recordUsage(groupId, SUMMARY_MODEL, msg.usage.input_tokens, msg.usage.output_tokens, "overlap_check");

  const raw = msg.content.filter(b => b.type === "text").map(b => (b as any).text).join("");
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  try {
    const result = JSON.parse(json) as { overlaps: Array<{ teammate: string; summary: string }> };
    return { hasOverlap: result.overlaps.length > 0, overlaps: result.overlaps };
  } catch {
    return { hasOverlap: false, overlaps: [] };
  }
}

/**
 * Returns a snapshot of what each contributor is focused on right now.
 * Built from user_context summaries — no new AI call needed.
 */

/**
 * Checks user_context summaries for overlap and folds the signal into incremental wisdom.
 * Called alongside runIncrementalWisdom when new items arrive.
 */
export async function checkContextOverlapForWisdom(groupId: string, newItems: Item[]): Promise<void> {
  const contexts = listUserContexts(groupId);
  if (contexts.length < 2) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;

  // Build a map of member_id → context summary
  const members = listMembers(groupId);
  const memberContexts = contexts.map(c => {
    const member = members.find(m => m.user_id === c.user_id);
    return { name: c.name, summary: c.summary, memberId: member?.id };
  });

  const newItemContributors = new Set(
    newItems.map(i => memberContexts.find(mc => mc.memberId === i.member_id)?.name).filter(Boolean)
  );
  if (!newItemContributors.size) return;

  const newContributorContexts = memberContexts.filter(mc => newItemContributors.has(mc.name));
  const otherContexts = memberContexts.filter(mc => !newItemContributors.has(mc.name));
  if (!otherContexts.length) return;

  const existing = listInsights(groupId);
  const client = new Anthropic({ apiKey });

  const msg = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 300,
    messages: [{
      role: "user",
      content: `You are checking if active researchers on a team are unknowingly working on the same thing.

Contributors who just added data and what they've been researching:
${newContributorContexts.map(c => `- ${c.name}: ${c.summary}`).join("\n")}

Other teammates' current research:
${otherContexts.map(c => `- ${c.name}: ${c.summary}`).join("\n")}

Existing insights (do not duplicate):
${existing.map(i => `- ${i.title}`).join("\n") || "(none)"}

If there is meaningful overlap between any of these researchers — same topic, same competitor, same question — generate one insight naming both people.
If no real overlap, return nothing.

Respond ONLY with valid JSON:
{"overlap":{"title":"...","body":"..."} | null}`,
    }],
  });
  recordUsage(groupId, SUMMARY_MODEL, msg.usage.input_tokens, msg.usage.output_tokens, "context_overlap");

  const raw = msg.content.filter(b => b.type === "text").map(b => (b as any).text).join("");
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  try {
    const result = JSON.parse(json) as { overlap: { title: string; body: string } | null };
    if (result.overlap) {
      if (existing.some(e => e.title.toLowerCase() === result.overlap!.title.toLowerCase())) return;
      const saved = addInsight(groupId, "pattern", result.overlap.title, result.overlap.body);
      setInsightStatus(saved.id, "acknowledged");
    }
  } catch { /* ignore parse errors */ }
}
