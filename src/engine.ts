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
  getGroupMemoryRaw, setGroupMemoryRaw, addGateRecord, isGlobalOverBudget, spokeRecently,
  type Item, type Insight,
} from "./db.js";

const MODEL = process.env.GW_MODEL || "claude-haiku-4-5-20251001"; // set GW_MODEL=claude-fable-5 to upgrade
const SUMMARY_MODEL = "claude-haiku-4-5-20251001";
const KINDS = ["convergence", "opportunity", "tension", "pattern", "direction", "decision"];

const running = new Set<string>();

/**
 * Every model call runs through this. Two ceilings: the per-user $50 covers
 * everything that user's communities and actions do in combination (the sum of
 * usage across every project they own), and the global switch bounds the
 * operator's total bill across all users. Previously only the two analysis
 * paths checked the user cap — summaries, user contexts and overlap checks
 * kept spending after it was hit.
 */
function analysisAllowed(groupId: string, purpose: string): boolean {
  if (isGroupOverBudget(groupId)) {
    console.warn(`[budget] group ${groupId} over user budget — skipping ${purpose}`);
    return false;
  }
  if (isGlobalOverBudget()) {
    console.warn(`[budget] GLOBAL budget reached — skipping ${purpose} for group ${groupId}`);
    return false;
  }
  return true;
}

/**
 * The output style bans em dashes, but pass 2's revisions kept leaking them:
 * the style rules lived only in pass 1's prompt, and the review pass rewrites
 * bodies. The prompts now both carry the rule, and this is the mechanical
 * backstop for what still slips through. Em dashes become sentence breaks;
 * spaced en dashes too (the unspaced ones stay — they are numeric ranges).
 */
export function stripEmDashes(s: string): string {
  return s
    .replace(/\s*—\s*(\p{L})?/gu, (_, c: string | undefined) => (c ? ". " + c.toUpperCase() : ". "))
    .replace(/\s+–\s+(\p{L})?/gu, (_, c: string | undefined) => (c ? ". " + c.toUpperCase() : ". "))
    .replace(/\s+$/g, "");
}

// ── Group memory ──────────────────────────────────────────────────────────────
// The engine's long-term working knowledge per project: a compact, structured
// record of what the group currently knows. Scans read memory plus the new
// items, never raw history, which keeps the cost per message flat no matter
// how large the archive grows — previously every scan re-sent the last 15 raw
// items and every insight ever surfaced, so both cost and blindness grew with
// the project. Facts carry the contributor and short source-item ids, so
// provenance survives distillation.

export type GroupMemory = {
  purpose: string;
  facts: Array<{ fact: string; by: string; sources: string[] }>;
  decisions: Array<{ decision: string; sources: string[] }>;
  open_questions: string[];
  // Wisdom already spoken and still standing — how the engine knows not to
  // repeat itself. Maintained mechanically in code, never by the model.
  active_wisdom: Array<{ id: string; kind: string; title: string }>;
};

// Mechanical backstops. The update prompt targets ~30 facts; these only bite
// if the model ignores its size discipline, so memory can never silently grow
// the cost per scan.
const MEMORY_MAX_FACTS = 40;
const MEMORY_MAX_WISDOM = 25;

const shortId = (id: string) => id.slice(0, 8);

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strArr = (v: unknown) => (Array.isArray(v) ? v.filter(x => typeof x === "string") as string[] : []);

/** Coerce whatever the model (or an old row) gave us into a well-formed core. */
function normalizeMemoryCore(raw: any): Omit<GroupMemory, "active_wisdom"> {
  return {
    purpose: str(raw?.purpose),
    facts: (Array.isArray(raw?.facts) ? raw.facts : [])
      .map((f: any) => ({ fact: str(f?.fact), by: str(f?.by), sources: strArr(f?.sources) }))
      .filter((f: any) => f.fact),
    decisions: (Array.isArray(raw?.decisions) ? raw.decisions : [])
      .map((d: any) => ({ decision: str(d?.decision), sources: strArr(d?.sources) }))
      .filter((d: any) => d.decision),
    open_questions: strArr(raw?.open_questions),
  };
}

export function loadGroupMemory(groupId: string): GroupMemory | null {
  const row = getGroupMemoryRaw(groupId);
  if (!row) return null;
  try {
    const raw = JSON.parse(row.memory);
    return {
      ...normalizeMemoryCore(raw),
      active_wisdom: (Array.isArray(raw?.active_wisdom) ? raw.active_wisdom : [])
        .map((w: any) => ({ id: str(w?.id), kind: str(w?.kind), title: str(w?.title) }))
        .filter((w: any) => w.id),
    };
  } catch {
    return null; // corrupt row — treat as missing and re-bootstrap
  }
}

function saveGroupMemory(groupId: string, mem: GroupMemory) {
  // Newest facts live at the end of the array, so trimming from the front
  // drops the oldest when the model has blown past its budget.
  mem.facts = mem.facts.slice(-MEMORY_MAX_FACTS);
  mem.active_wisdom = mem.active_wisdom.slice(-MEMORY_MAX_WISDOM);
  setGroupMemoryRaw(groupId, JSON.stringify(mem));
}

/** Item line for the memory prompts: short id so facts can cite their sources. */
function memoryItemLine(i: Item & { member_name?: string | null }, contentCap: number) {
  const content = (i.content ?? "").slice(0, contentCap);
  return `[${shortId(i.id)}] [${i.type}]${i.member_name ? ` [by ${i.member_name}]` : ""} "${i.title}" — ${content}`;
}

const MEMORY_SHAPE =
  `{"purpose":"...","facts":[{"fact":"...","by":"contributor name","sources":["short item id"]}],` +
  `"decisions":[{"decision":"...","sources":["..."]}],"open_questions":["..."]}`;

const MEMORY_RULES = `Rules:
- One sentence per fact. "by" is whoever actually contributed it — never move a finding from one contributor to another. "sources" keeps the item ids in [brackets].
- Newest wins: when a contribution corrects or updates an earlier fact on the same point, replace the old fact and keep the new source id.
- Record decisions the group has clearly made, and open questions that are genuinely open. Delete questions that have been answered.
- Not everything is a fact. Chatter, acknowledgements and coordination add nothing; skip them.
- Keep facts in the order they were learned, newest last.
- Size discipline: at most about 30 facts. When over, merge the oldest and least consequential into fewer, shorter entries, keeping their source ids.`;

/**
 * One-time distillation of an existing project's history into its first
 * memory. Runs once per group, on the first scan after this feature ships
 * (or the first scan of a new group, over whatever exists).
 */
async function bootstrapGroupMemory(groupId: string, groupName: string): Promise<GroupMemory> {
  const items = listItemsWithMembers(groupId).slice(0, 50);
  const activeWisdom = listInsights(groupId).slice(0, MEMORY_MAX_WISDOM).reverse()
    .map(i => ({ id: i.id, kind: i.kind, title: i.title }));

  if (!items.length) {
    const mem = { purpose: "", facts: [], decisions: [], open_questions: [], active_wisdom: activeWisdom };
    saveGroupMemory(groupId, mem);
    return mem;
  }

  const client = new Anthropic();
  const msg = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 1500,
    messages: [{
      role: "user",
      content: `You maintain the working memory of a shared project called "${groupName}": the compact record of what the group currently knows. It is the only long-term context the wisdom engine sees, so a fact dropped here is forgotten and a fact kept here is remembered.

The project's contributions so far (newest first):
${items.map(i => memoryItemLine(i, 700)).join("\n")}

Distill them into the project's memory.

${MEMORY_RULES}

Respond ONLY with valid JSON:
${MEMORY_SHAPE}`,
    }],
  });
  recordUsage(groupId, SUMMARY_MODEL, msg.usage.input_tokens, msg.usage.output_tokens, "memory_bootstrap");

  const raw = msg.content.filter(b => b.type === "text").map(b => (b as any).text).join("");
  const core = normalizeMemoryCore(JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)));
  const mem = { ...core, active_wisdom: activeWisdom };
  saveGroupMemory(groupId, mem);
  return mem;
}

/**
 * Fold a batch of new items into the memory core, and say whether the batch
 * actually contributed anything.
 *
 * That second job is what stops the engine talking over a conversation. Asking
 * a teammate for something adds no work to the group, but the engine used to
 * scan on it anyway, and a model asked to find something in a full memory will
 * find something — which is how "build the plan for these three cities"
 * produced a finding recombined entirely from what was already known. This
 * call already reads the new items with full context, so the judgement costs
 * nothing extra.
 */
type MemoryUpdate = {
  core: Omit<GroupMemory, "active_wisdom">;
  contributed: boolean;
  why: string;
};

async function updateMemoryCore(
  groupId: string, groupName: string, mem: GroupMemory, newItems: (Item & { member_name?: string | null })[],
): Promise<MemoryUpdate> {
  const { active_wisdom: _, ...core } = mem;
  const overBudget = mem.facts.length > 30;

  const client = new Anthropic();
  const msg = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 1500,
    messages: [{
      role: "user",
      content: `You maintain the working memory of a shared project called "${groupName}": the compact record of what the group currently knows. It is the only long-term context the wisdom engine sees, so a fact dropped here is forgotten and a fact kept here is remembered.

Current memory:
${JSON.stringify(core)}

New contribution${newItems.length > 1 ? "s" : ""}:
${newItems.map(i => memoryItemLine(i, 1500)).join("\n")}

Update the memory and return it in full. If the new contributions add nothing durable, return the memory unchanged.

${MEMORY_RULES}${overBudget ? "\n- The memory is over budget right now, compress it this round." : ""}

Also judge one thing about the new contributions, in "contributed":
- true when someone DELIVERED work: a result, a finding, data, an analysis, a document, a decision they have made.
- false when they only ask for something, instruct someone, ask a question, greet, acknowledge, agree, or arrange logistics. Asking a teammate to do work is not doing work.
- A request that carries details is still a request. "Build the plan for Chicago, San Francisco and New York" names three cities and remains an instruction: saying what you want does not make it done. Judge by whether work was delivered, never by whether the message contained new words. Record the detail as a fact if it is durable, and still answer false.
Put the reason in "why", in a few words.

Respond ONLY with valid JSON:
{"purpose":"...","facts":[...],"decisions":[...],"open_questions":[...],"contributed":true,"why":"..."}
where facts, decisions and open_questions follow ${MEMORY_SHAPE}`,
    }],
  });
  recordUsage(groupId, SUMMARY_MODEL, msg.usage.input_tokens, msg.usage.output_tokens, "memory_update");

  const raw = msg.content.filter(b => b.type === "text").map(b => (b as any).text).join("");
  const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  return {
    core: normalizeMemoryCore(parsed),
    // Default to true: a missing field must not silence the engine outright.
    contributed: parsed?.contributed !== false,
    why: str(parsed?.why) || "no reason given",
  };
}

/**
 * Keep active_wisdom current when insights are created outside the incremental
 * path (the full analyzeGroup used by the dashboard and /analyze). Without
 * this, memory would not know that wisdom exists and the engine could repeat it.
 */
function appendActiveWisdom(groupId: string, insights: Insight[]) {
  if (!insights.length) return;
  const mem = loadGroupMemory(groupId);
  if (!mem) return; // not bootstrapped yet — bootstrap seeds from listInsights, so nothing is lost
  mem.active_wisdom.push(...insights.map(i => ({ id: i.id, kind: i.kind, title: i.title })));
  saveGroupMemory(groupId, mem);
}

/** Gate records must never break the wisdom path they exist to explain. */
function recordGate(groupId: string, rec: Parameters<typeof addGateRecord>[1]) {
  try { addGateRecord(groupId, rec); } catch (err: any) {
    console.warn(`[gate] could not record verdict for group ${groupId}: ${err.message}`);
  }
}

// ── The scout and the editor ─────────────────────────────────────────────────
// These were one call: "surface a finding" plus a reviewer deciding whether to
// keep it. A model told to write something writes something, and once a fluent
// draft exists the reviewer is judging competent prose rather than deciding
// whether anything was there. Splitting them puts a yes/no question first,
// which is a far easier place to get an honest no. The scout writes no prose,
// and on the normal answer (no) nothing else runs.

/** What both the scout and the editor must believe before anything is said. */
const WISDOM_TESTS = `A finding is real ONLY if every one of these holds:

1. Two pieces of work, produced separately. The finding must join the new
   contribution to something ELSE the group already holds, and that something must
   not be the message this one is answering. The two pieces may come from the same
   contributor: an agent that wrote a budget plan for one question and a schedule
   for another can disagree with itself across them, and nobody is holding both at
   once. What never counts is a single exchange read against itself, one message
   asking and the next answering.
2. Not a restatement. Summarising, restating or tidying up one piece of work is
   never wisdom, however well written. Neither is narrating what is happening
   ("X asked for Y while Z did W"). Test it like this: take away everything the new
   message itself says. If nothing is left, there was no finding.
3. Nobody has said it. It is absent from the memory and from the wisdom already spoken.
4. It changes what someone does next. A pending request is not something to have a
   finding about: the answer is on its way. If the natural reply to your finding is
   "that is what was just asked for", it is not wisdom.
5. It points at specific contributions that produced it.

Contributors are people and AI agents alike. An agent that researches, drafts or
analyses is a contributor exactly as a person is. A person working with one agent
is a group, and what that agent produced earlier is part of what the group holds.
Never discount a contribution for coming from an agent.

Most of the time nothing passes. That is the normal, correct answer.`;

type ScoutVerdict = { worth_drafting: boolean; hypothesis: string; sources: string[]; why: string };

/** Point at a possible combination, or (usually) say there isn't one. Writes no wisdom. */
async function scoutForCandidate(
  groupId: string, groupName: string, newText: string, memoryText: string, tailText: string, wisdomText: string,
): Promise<ScoutVerdict> {
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 300,
    messages: [{
      role: "user",
      content: `You are the scout for a shared project called "${groupName}". Your only job is to
decide whether there is a combination here worth a closer look. You never write
the finding itself.

New contribution${newText.includes("\n") ? "s" : ""}:
${newText}

What the group already knows, distilled from its whole history. Facts carry the
contributor's name and source item ids:
${memoryText}

The last few messages, for conversational context only:
${tailText}

Wisdom already spoken (anything close to these is not new):
${wisdomText}

${WISDOM_TESTS}

Answer with a hypothesis only when you can name BOTH pieces of work being joined,
and the second one is not simply the request this message answers. Reaching back
into memory for that second piece is the whole job. If the only thing you can
point at is the message in front of you, the answer is no.

Respond ONLY with valid JSON:
{"worth_drafting":false,"hypothesis":"","sources":[],"why":"one short sentence naming the test that failed"}`,
    }],
  });
  recordUsage(groupId, SUMMARY_MODEL, msg.usage.input_tokens, msg.usage.output_tokens, "scout");

  const raw = msg.content.filter(b => b.type === "text").map(b => (b as any).text).join("");
  const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  return {
    // Default to NOT drafting: a malformed verdict must fail closed, toward silence.
    worth_drafting: parsed?.worth_drafting === true,
    hypothesis: str(parsed?.hypothesis),
    sources: strArr(parsed?.sources),
    why: str(parsed?.why) || "scout found no combination",
  };
}

type DraftResult = {
  new: Array<{ kind: string; title: string; body: string }>;
  dismiss: string[];
  why_silent?: string | null;
};

/** Draft the finding the scout pointed at, or decline it on a second look. */
async function draftFinding(
  groupId: string, groupName: string, members: string, scout: ScoutVerdict,
  newText: string, memoryText: string, tailText: string, wisdomText: string,
): Promise<DraftResult> {
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 700,
    messages: [{
      role: "user",
      content: `You are the Wisdom engine for a shared project called "${groupName}".
Members: ${members}

The scout thinks there may be a finding here:
"${scout.hypothesis}"
drawn from: ${scout.sources.join(", ") || "(unspecified)"}

New contribution${newText.includes("\n") ? "s" : ""}:
${newText}

What the group already knows, distilled from its whole history:
${memoryText}

The last few messages, for conversational context only:
${tailText}

Current wisdom (never repeat these; flag any now outdated):
${wisdomText}

${WISDOM_TESTS}

The scout is often wrong. Check its hypothesis against the tests yourself, and
return an empty list if it does not hold. In particular, check that the finding
survives test 2: if it disappears once you take away what the new message itself
says, it was a restatement wearing a second source as decoration. Returning
nothing is always better than reaching, and it is not a failure.

At most ONE finding. Never two.

When you do speak, the body is the whole message. It is posted on its own in a
chat, so it must carry the finding without the title.

- Write it the way a sharp colleague would say it out loud. Plain words, full
  sentences. Not "validating the segmentation hypothesis that the value
  proposition resonates" — say what actually happened.
- Two sentences. Around 40 words. Stop there.
- No em dashes. Use full stops.
- Hand over the finished work. Give the other contributor's actual finding, with
  their real numbers, so the reader inherits it and skips that step. Never tell
  anyone to go and do something with it. No "you can start by", no "test
  whether", no "evaluate whether", no "adapt it". If all you have is a
  suggestion of work someone could do, you have no finding.
- Give each person's own findings and numbers, attributed to them. Never put one
  person's figure in someone else's mouth, and never smooth a disagreement into
  agreement. Where two contributions differ, that difference is the finding.
- Frame it as what the group has built or found, not as what it lacks or has got
  wrong.
- No hedging inside the sentences. If a caveat matters it goes in the caveat field.

Kinds: convergence (two people reached the same finding from different directions),
opportunity (something their own work points at that nobody has picked up),
tension (two views worth putting together, stated as the actual difference),
pattern (a theme across several contributions none of them named), direction (the
next question their work is building toward), decision (something they have
arrived at, and what led there). Choose the one that actually fits.

Give a short title too, one sentence for the dashboard, but write the body so it
still reads correctly with the title removed.

Also list IDs of any existing wisdom now stale, resolved, or superseded.

When you return no finding, name the test that failed in "why_silent".

Respond ONLY with valid JSON:
{"new":[{"kind":"...","title":"...","body":"..."}],"dismiss":["id1"],"why_silent":null}`,
    }],
  });
  recordUsage(groupId, SUMMARY_MODEL, msg.usage.input_tokens, msg.usage.output_tokens, "editor");

  const raw = msg.content.filter(b => b.type === "text").map(b => (b as any).text).join("");
  return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
}

// ── Incremental Wisdom (Haiku, runs on every item add) ───────────────────────

/**
 * Minutes a project stays quiet after speaking. Two good findings a minute
 * apart still merge into one wall of text in a chat client.
 */
const WISDOM_COOLDOWN_MIN = Number(process.env.GW_WISDOM_COOLDOWN_MIN || 10);

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

  // Build a map of member_id → name for new items (they come in as plain Items)
  const memberNames = new Map(allWithMembers.filter(i => i.member_name).map(i => [i.id, i.member_name!]));
  const newWithNames = newItems.map(i => ({ ...i, member_name: memberNames.get(i.id) ?? null }));

  // How much of each item the incremental prompt may see. 120 characters was far
  // too little: anything substantial — an agent's reply, a pasted document, a
  // detailed finding — was cut off after roughly one sentence, and the engine
  // then reported (correctly) that it could not assess the truncated content.
  const ITEM_CONTENT_LIMIT = 1500;

  const fmt = (i: Item & { member_name?: string | null }) => {
    const by = i.member_name ? ` [by ${i.member_name}]` : "";
    const content = i.content ?? "";
    const shown = content.length > ITEM_CONTENT_LIMIT
      ? content.slice(0, ITEM_CONTENT_LIMIT) + " …[truncated]"
      : content;
    return `[${i.type}]${by} "${i.title}"${i.url ? ` (${i.url})` : ""} — ${shown}`;
  };

  const newText = newWithNames.map(fmt).join("\n");

  // A short raw tail for conversational continuity only — the substance of the
  // history lives in memory, which covers the whole archive. Both are fixed
  // size, so the scan costs the same on day one and day five hundred.
  const tail = allWithMembers.filter(i => !newItems.some(n => n.id === i.id)).slice(0, 5);
  const tailText = tail.map(i => {
    const content = (i.content ?? "").slice(0, 300);
    return `[${i.type}]${i.member_name ? ` [by ${i.member_name}]` : ""} "${i.title}" — ${content}`;
  }).join("\n") || "(none)";

  if (!process.env.ANTHROPIC_API_KEY) {
    return []; // no mock for incremental — just skip
  }

  if (!analysisAllowed(groupId, "incremental scan")) return [];

  // Memory: the whole history, distilled. Bootstrapped once per project, then
  // folded forward batch by batch. If bootstrap fails we scan on a stub this
  // round and do NOT persist it — saving a stub would permanently block the
  // real bootstrap from ever running.
  let memory: GroupMemory | null = null;
  try {
    memory = loadGroupMemory(groupId) ?? await bootstrapGroupMemory(groupId, group.name);
  } catch (err: any) {
    console.warn(`[memory] bootstrap failed for group ${groupId}: ${err.message} — scanning without memory this round`);
  }
  const scanMemory: GroupMemory = memory ?? {
    purpose: "", facts: [], decisions: [], open_questions: [],
    active_wisdom: existing.slice(0, MEMORY_MAX_WISDOM).reverse().map(i => ({ id: i.id, kind: i.kind, title: i.title })),
  };

  // Memory first, then decide whether to think at all. It has to run sequentially
  // now because its verdict on whether this batch contributed anything is the
  // first gate: a request adds nothing to combine, so there is nothing to scan.
  const update = memory
    ? await updateMemoryCore(groupId, group.name, memory, newWithNames)
        .catch((err: any) => { console.warn(`[memory] update failed for group ${groupId}: ${err.message}`); return null; })
    : null;

  const memoryText = JSON.stringify({
    purpose: scanMemory.purpose, facts: scanMemory.facts,
    decisions: scanMemory.decisions, open_questions: scanMemory.open_questions,
  });
  const wisdomText = scanMemory.active_wisdom.map(w => `[${w.id}] [${w.kind}] ${w.title}`).join("\n") || "(none)";

  // The batch's items must reach memory on every exit from here on — silence,
  // parse failure and spoken wisdom alike — or they simply never happened as
  // far as future scans are concerned.
  const finalizeMemory = async (created: Insight[], dismissedIds: string[]) => {
    if (!memory) return; // bootstrap failed — don't persist the stub
    const core = update?.core ?? {
      purpose: memory.purpose, facts: memory.facts,
      decisions: memory.decisions, open_questions: memory.open_questions,
    };
    const active = memory.active_wisdom
      .filter(w => !dismissedIds.includes(w.id))
      .concat(created.map(i => ({ id: i.id, kind: i.kind, title: i.title })));
    saveGroupMemory(groupId, { ...core, active_wisdom: active });
  };

  // Gate 1 — did anything actually get contributed? Asking a teammate for work
  // adds nothing to combine, and scanning on it is where the restatements came
  // from. Memory still learns from the message either way.
  if (update && !update.contributed) {
    recordGate(groupId, { stage: "scan", verdict: "silent", reason: `No new contribution: ${update.why}` });
    await finalizeMemory([], []);
    return [];
  }

  // Gate 2 — a floor between cards. Two findings minutes apart stack into one
  // wall of text in the channel, which reads as an agent that will not stop.
  if (spokeRecently(groupId, WISDOM_COOLDOWN_MIN)) {
    recordGate(groupId, { stage: "scan", verdict: "silent", reason: `Spoke within the last ${WISDOM_COOLDOWN_MIN} minutes.` });
    await finalizeMemory([], []);
    return [];
  }

  // Gate 3 — the scout. A yes/no question, answered without writing any wisdom.
  let scout: ScoutVerdict;
  try {
    scout = await scoutForCandidate(groupId, group.name, newText, memoryText, tailText, wisdomText);
  } catch (err: any) {
    console.warn(`[scout] failed for group ${groupId}: ${err.message}`);
    recordGate(groupId, { stage: "scan", verdict: "error", reason: `scout failed: ${err.message}` });
    await finalizeMemory([], []);
    return [];
  }
  if (!scout.worth_drafting) {
    recordGate(groupId, { stage: "scan", verdict: "silent", reason: scout.why });
    await finalizeMemory([], []);
    return [];
  }
  console.log(`[scout] candidate for group ${groupId}: ${scout.hypothesis}`);

  // The editor drafts only what the scout pointed at, and may still decline it.
  let result: DraftResult;
  try {
    result = await draftFinding(
      groupId, group.name, listMembers(groupId).map(m => m.name).join(", ") || "unknown",
      scout, newText, memoryText, tailText, wisdomText,
    );
  } catch (err: any) {
    // Silently returning [] here made a non-responding engine indistinguishable
    // from one that legitimately had nothing to say. Say which it was.
    console.warn(`[wisdom] editor failed for group ${groupId}: ${err.message}`);
    recordGate(groupId, { stage: "scan", verdict: "error", reason: `editor failed: ${err.message}` });
    await finalizeMemory([], []);
    return [];
  }

  // The editor produced candidates. Normalise them before the review pass.
  const candidates = (result.new ?? [])
    .map(ins => {
      // The model occasionally labels wisdom with a kind outside our set (e.g. "insight").
      // Dropping it loses a genuinely good finding over a label mismatch, so fall back to
      // the most general kind instead and record that we did.
      if (!KINDS.includes(ins.kind)) {
        console.warn(`[wisdom] relabelled unknown kind "${ins.kind}" → "pattern" for "${ins.title}"`);
        return { ...ins, kind: "pattern" };
      }
      return ins;
    })
    .filter(ins => !existing.some(e => e.title.toLowerCase() === ins.title.toLowerCase()));

  // The review pass. This runs here too, not just in the full analysis: live
  // sources (Buzz channels, the API) go through the incremental path, and
  // without this they produced wisdom with no confidence, caveat, do_next or
  // missing_voice at all — the review simply never ran on them.
  const annotated = candidates.length
    ? await metacognitivePass(
        candidates, group.name, listMembers(groupId).map(m => m.name),
        allWithMembers.length, getGroupEngine(groupId), groupId,
      )
    : [];

  // Gate record for silence — the reason the engine said nothing, queryable
  // later instead of reconstructable only by pasting test messages into a
  // live channel.
  if (!candidates.length) {
    const reason = (result.new ?? []).length
      ? "candidate duplicated existing wisdom (title match)"
      : (result.why_silent?.trim() || "editor declined the scout's hypothesis");
    recordGate(groupId, { stage: "scan", verdict: "silent", reason });
  }

  const suppressed = annotated.filter(ins => !ins.keep);
  if (suppressed.length) {
    console.log(`[metacognitive] suppressed ${suppressed.length} weak insight(s) for group ${groupId}: ` +
      suppressed.map(ins => `"${ins.title}" (confidence: ${ins.confidence})`).join(", "));
    for (const ins of suppressed) {
      recordGate(groupId, {
        stage: "review", verdict: "suppressed", kind: ins.kind, title: ins.revised_title ?? ins.title,
        reason: ins.drop_reason ?? `confidence ${ins.confidence}`,
      });
    }
  }

  const created: Insight[] = [];
  for (const ins of annotated) {
    if (!ins.keep) continue;
    const saved = addInsight(groupId, ins.kind, stripEmDashes(ins.revised_title ?? ins.title), stripEmDashes(ins.revised_body ?? ins.body), {
      confidence: ins.confidence,
      caveat: ins.caveat ? stripEmDashes(ins.caveat) : undefined,
      do_next: ins.do_next ? stripEmDashes(ins.do_next) : undefined,
      missing_voice: ins.missing_voice ?? undefined,
    });
    setInsightStatus(saved.id, "acknowledged"); // auto-accept live insights
    created.push({ ...saved, status: "acknowledged" });
    recordGate(groupId, {
      stage: "review", verdict: "spoken", kind: saved.kind, title: saved.title,
      reason: `confidence ${ins.confidence}`, insightId: saved.id,
    });
  }
  const dismissed = (result.dismiss ?? []).filter(id => existing.some(e => e.id === id));
  for (const id of dismissed) setInsightStatus(id, "dismissed");

  await finalizeMemory(created, dismissed);
  return created;
}

export type ProposedInsight = { kind: string; title: string; body: string };

/** Preview mode: run the engine but don't save anything. Returns proposed insights for user review. */
export async function previewAnalysis(groupId: string): Promise<ProposedInsight[]> {
  const group = getGroup(groupId);
  if (!group) return [];
  const items = listItems(groupId);
  if (items.length === 0) return [];
  if (process.env.ANTHROPIC_API_KEY && !analysisAllowed(groupId, "preview analysis")) return [];
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

    if (process.env.ANTHROPIC_API_KEY && !analysisAllowed(groupId, "full analysis")) return [];

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
      created.push(addInsight(groupId, ins.kind, stripEmDashes(title), stripEmDashes(body), {
        confidence: ins.confidence,
        caveat: ins.caveat ? stripEmDashes(ins.caveat) : undefined,
        do_next: ins.do_next ? stripEmDashes(ins.do_next) : undefined,
        missing_voice: ins.missing_voice ?? undefined,
      }));
    }
    if (result.knowledge_markdown) setKnowledgeDoc(groupId, result.knowledge_markdown);
    // Memory must learn about wisdom born here too, or the incremental engine
    // could say the same thing again in the channel.
    appendActiveWisdom(groupId, created);
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
   0-4 insights. Quality over quantity. Each: short title + a body of 1-2 sentences (up to ~45 words). Direct, no qualifiers. Frame everything in terms of what the group is building together, not what is missing.
   CRUCIAL — transfer knowledge, never point to it: when one member's work is relevant to another's, state that member's actual finding inline so the reader inherits it directly and lands two steps ahead. Never write "check with", "pull in", "coordinate with", or "look at" someone's work — deliver the finding itself, attributed by name.
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
  drop_reason: string | null;
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
- caveat: one short sentence naming the condition under which this would not hold, or null if solid. State it as a fact about the evidence — never as an instruction. Do not write "clarify", "confirm", "check", "verify" or "determine whether"; say what is assumed, not what someone should go do.
- do_next: NOT a task, and not a suggestion of work. This field states one more completed result from another member that the reader now has for free, and then stops. e.g. "Maya's morale timeline already dates the drop to just after Stalingrad." Never write "you can", "start by", "test whether", "evaluate whether", "adapt", "check", "map", "verify" or "coordinate". If the only thing you can write is something the reader ought to go and do, use null. Most of the time null is right, because the body already carried the finding.
- missing_voice: name of a contributor whose existing work would strengthen this reader's, or null
- keep: false if the insight is too speculative, too thin, or not yet ready to surface — otherwise true
- drop_reason: when keep is false, one short sentence naming why (too thin, single-source, already known, speculative). null when keep is true.
- revised_title: a sharper version of the title if the original is vague, buries the finding, or understates the evidence — otherwise null. Must be under 12 words.
- revised_body: a revised body if you can materially improve clarity or precision, or fold in another member's actual finding so the reader inherits it directly rather than being pointed to it — otherwise null. Keep it to 1-2 sentences. Two things always require a revision: a body running past two sentences or roughly 45 words, which you cut back; and any sentence suggesting the reader consult, review or clarify something, which you delete outright. A finding that only survives by pointing somewhere is not a finding.

Only revise when you can genuinely improve the text. Null means the original is good enough.
Be strict on keep. It is better to suppress a weak insight than to deliver noise.

Style for every field you write (caveat, do_next, revised_title, revised_body): plain full
sentences with full stops. Never use an em dash anywhere. Keep each person's own findings
and numbers attributed to that person. A revised_body stays at 1-2 sentences, around 40 words.

Respond with ONLY valid JSON — an array matching the candidate order:
[{"id":0,"confidence":"high","caveat":null,"do_next":"...","missing_voice":null,"keep":true,"drop_reason":null,"revised_title":null,"revised_body":null},...]`;

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
      return candidates.map(c => ({ ...c, confidence: "medium", caveat: null, do_next: null, missing_voice: null, keep: true, drop_reason: null, revised_title: null, revised_body: null }));
    }

    const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
    const results = JSON.parse(json) as Array<{ id: number; confidence: string; caveat: string | null; do_next: string | null; missing_voice: string | null; keep: boolean; drop_reason: string | null; revised_title: string | null; revised_body: string | null }>;

    return candidates.map((c, i) => {
      const r = results.find(x => x.id === i);
      return {
        ...c,
        confidence: r?.confidence ?? "medium",
        caveat: r?.caveat ?? null,
        do_next: r?.do_next ?? null,
        missing_voice: r?.missing_voice ?? null,
        keep: r?.keep ?? true,
        drop_reason: r?.drop_reason ?? null,
        revised_title: r?.revised_title ?? null,
        revised_body: r?.revised_body ?? null,
      };
    });
  } catch (err) {
    console.error("[metacognitive]", (err as Error).message);
    return candidates.map(c => ({ ...c, confidence: "medium", caveat: null, do_next: null, missing_voice: null, keep: true, drop_reason: null, revised_title: null, revised_body: null }));
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
   0-4 insights. Quality over quantity. Each: short title + a body of 1-2 sentences (up to ~45 words). Direct, no qualifiers. Frame everything in terms of what the group is building together, not what is missing.
   CRUCIAL — transfer knowledge, never point to it: when one member's work is relevant to another's, state that member's actual finding inline so the reader inherits it directly and lands two steps ahead. Never write "check with", "pull in", "coordinate with", or "look at" someone's work — deliver the finding itself, attributed by name.
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

  if (!analysisAllowed(groupId, "project summary")) return;

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

  if (!analysisAllowed(groupId, "user context")) return;

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
  if (process.env.ANTHROPIC_API_KEY && !analysisAllowed(groupId, "contributor overlap")) return { hasOverlap: false, overlaps: [] };

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
  if (!analysisAllowed(groupId, "context overlap")) return;

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
