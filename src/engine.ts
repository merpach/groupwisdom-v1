/**
 * The insight engine.
 * Looks at everything the group has shared and surfaces:
 * connections, blind spots, conflicts, patterns, questions worth asking, decisions.
 * Also maintains the group's living knowledge-base markdown document.
 *
 * Uses the Claude API when ANTHROPIC_API_KEY is set; otherwise falls back to
 * a deterministic mock so the whole product works offline.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  listItems, listMembers, listInsights, addInsight,
  setKnowledgeDoc, getGroup, setProjectSummary, setUserContext,
  getMemberByUserId, listItemsByMember, type Item, type Insight,
} from "./db.js";

const MODEL = process.env.GW_MODEL || "claude-sonnet-4-6";
const SUMMARY_MODEL = "claude-haiku-4-5-20251001";
const KINDS = ["connection", "blind_spot", "conflict", "pattern", "question", "decision"];

const running = new Set<string>();

export type ProposedInsight = { kind: string; title: string; body: string };

/** Preview mode: run the engine but don't save anything. Returns proposed insights for user review. */
export async function previewAnalysis(groupId: string): Promise<ProposedInsight[]> {
  const group = getGroup(groupId);
  if (!group) return [];
  const items = listItems(groupId);
  if (items.length === 0) return [];
  const members = listMembers(groupId);
  const existing = listInsights(groupId);

  const result = process.env.ANTHROPIC_API_KEY
    ? await analyzeWithClaude(group.name, items, members.map(m => `${m.name} (${m.role})`), existing)
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
    const items = listItems(groupId);
    if (items.length === 0) return [];
    const members = listMembers(groupId);
    const existing = listInsights(groupId);

    const result = process.env.ANTHROPIC_API_KEY
      ? await analyzeWithClaude(group.name, items, members.map(m => `${m.name} (${m.role})`), existing)
      : analyzeMock(group.name, items, existing);

    const created: Insight[] = [];
    for (const ins of result.insights) {
      if (!KINDS.includes(ins.kind)) continue;
      if (existing.some(e => e.title.toLowerCase() === ins.title.toLowerCase())) continue;
      created.push(addInsight(groupId, ins.kind, ins.title, ins.body));
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
  groupName: string, items: Item[], members: string[], existing: Insight[],
): Promise<EngineResult> {
  const client = new Anthropic();
  const itemsText = items
    .map(i => `- [${i.type}] "${i.title}" ${i.url ? `(${i.url}) ` : ""}— ${i.content}`.trim())
    .join("\n");
  const existingText = existing.map(e => `- [${e.kind}] ${e.title}`).join("\n") || "(none)";

  const prompt = `You are the GroupWisdom insight engine: the shared brain of a group called "${groupName}".
Members: ${members.join(", ") || "(unknown)"}

Everything the group has shared (newest first):
${itemsText}

Insights already surfaced (do NOT repeat these):
${existingText}

Tasks:
1. Surface NEW insights only where there is real signal. Allowed kinds:
   - connection: two shared things link in an unexpected way
   - blind_spot: something obvious the group has not looked at
   - conflict: two pieces of information contradict each other
   - pattern: multiple data points imply a conclusion no one stated
   - question: something the group should be considering but is not
   - decision: something the group has decided, and what led to it
   0-4 insights. Quality over quantity. Each: short title + 1-2 sentence body.
2. Rewrite the group's living knowledge-base document as clean markdown:
   a title, a one-line italic summary, then sections that organize what is known.
   Include open questions. Keep it under 400 words.

Respond with ONLY valid JSON:
{"insights":[{"kind":"...","title":"...","body":"..."}],"knowledge_markdown":"..."}`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    messages: [{ role: "user", content: prompt }],
  });
  const text = msg.content.filter(b => b.type === "text").map(b => (b as any).text).join("");
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
      kind: "pattern", title: t,
      body: `${top[1].length} of ${items.length} shared items mention "${top[0]}". A shared focus is emerging that no one has named yet.`,
    });
  }

  // connection: newest item shares a word with an older one
  const newest = items[0];
  if (newest && items.length >= 2) {
    const words = new Set((newest.title + " " + newest.content).toLowerCase().match(/[a-zà-ö]{6,}/g) ?? []);
    const other = items.slice(1).find(it =>
      [...words].some(w => (it.title + " " + it.content).toLowerCase().includes(w)));
    if (other) {
      const t = `"${newest.title}" relates to "${other.title}"`;
      if (!has(t)) insights.push({
        kind: "connection", title: t,
        body: "Two items shared by different moments overlap. Worth looking at them side by side.",
      });
    }
  }

  // blind spot: everything is the same type
  const types = new Set(items.map(i => i.type));
  if (items.length >= 4 && types.size === 1) {
    const t = `Everything shared so far is a ${[...types][0]}`;
    if (!has(t)) insights.push({
      kind: "blind_spot", title: t,
      body: "No other kinds of input yet. Files, links, or raw thoughts might fill in what is missing.",
    });
  }

  // question: standing prompt once enough material exists
  if (items.length >= 5) {
    const t = "What has the group decided so far?";
    if (!has(t)) insights.push({
      kind: "question", title: t,
      body: "A lot has been shared but nothing is marked as decided. Worth stating decisions explicitly so they are not lost.",
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

  const summary = msg.content.filter(b => b.type === "text").map(b => (b as any).text).join("").trim();
  if (summary) setUserContext(userId, groupId, summary);
}
