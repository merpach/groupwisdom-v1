import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getGroupByKey, getGroup, listGroups,
  getUserByApiKey, getGroupsForUser,
  addItem, searchItems, listItems, listInsights, getKnowledgeDoc, touchConnector,
} from "./db.js";
import { analyzeGroup } from "./engine.js";

function getPersonGroups() {
  const key = process.env.GW_API_KEY;
  if (!key) return listGroups();
  // personal user API key → all their groups
  const user = getUserByApiKey(key);
  if (user) return getGroupsForUser(user.id);
  // fallback: old group-level key
  const byGroup = getGroupByKey(key);
  return byGroup ? [byGroup] : [];
}

function resolveGroup(name?: string) {
  const groups = getPersonGroups();
  if (!groups.length) return undefined;
  if (name) {
    const q = name.toLowerCase();
    return groups.find(g => g.name.toLowerCase().includes(q)) ?? groups[0];
  }
  return groups[0];
}

const server = new McpServer({ name: "groupwisdom", version: "1.0.0" });
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

const projectParam = z.string().optional().describe(
  "Project name (or partial name) to use. If omitted, uses the default project. " +
  "Always pass this when the user mentions a specific project or trip by name."
);

server.tool(
  "list_projects",
  "List all GroupWisdom projects this person has access to. Call this first when the user mentions a project or trip by name.",
  {},
  async () => {
    const groups = getPersonGroups();
    if (!groups.length) return text("No projects yet. Create one at http://localhost:3000");
    return text(groups.map(g => `- ${g.name} (id: ${g.id})`).join("\n"));
  },
);

server.tool(
  "get_group_context",
  "Get everything a project knows: its knowledge document plus recent insights. " +
  "Always pass the project param when the user mentions a specific project by name.",
  { project: projectParam },
  async ({ project }) => {
    const g = resolveGroup(project);
    if (!g) return text("No projects found. Create one at http://localhost:3000");
    touchConnector(g.id, "Claude");
    const doc = getKnowledgeDoc(g.id);
    const insights = listInsights(g.id).slice(0, 10)
      .map(i => `- [${i.kind}] ${i.title}: ${i.body}`).join("\n") || "(none yet)";
    return text(`# Project: ${g.name}\n\n## Knowledge base\n${doc.markdown}\n\n## Recent insights\n${insights}`);
  },
);

server.tool(
  "search_group_knowledge",
  "Search everything a project has shared (links, notes, files, thoughts).",
  {
    query: z.string().describe("Search query"),
    project: projectParam,
  },
  async ({ query, project }) => {
    const g = resolveGroup(project);
    if (!g) return text("No projects found.");
    touchConnector(g.id, "Claude");
    const hits = searchItems(g.id, query);
    if (hits.length === 0) return text(`No items match "${query}" in project "${g.name}".`);
    return text(hits.map(h =>
      `- [${h.type}] ${h.title}${h.url ? ` (${h.url})` : ""}\n  ${h.content}`).join("\n"));
  },
);

server.tool(
  "save_to_group",
  "Save something to a project's shared knowledge base. The insight engine immediately checks for new connections.",
  {
    title: z.string().describe("Short title"),
    content: z.string().describe("The content or context to save"),
    url: z.string().optional().describe("Optional URL"),
    type: z.enum(["link", "note", "file", "thought"]).optional().describe("Kind of item (default: note)"),
    project: projectParam,
  },
  async ({ title, content, url, type, project }) => {
    const g = resolveGroup(project);
    if (!g) return text("No projects found.");
    const item = addItem(g.id, { title, content, url: url ?? "", type: type ?? (url ? "link" : "note"), source: "mcp" });
    touchConnector(g.id, "Claude");
    const created = await analyzeGroup(g.id).catch(() => []);
    return text(
      `Saved "${item.title}" to "${g.name}".` +
      (created.length ? `\n\nNew insights:\n` +
        created.map(i => `- [${i.kind}] ${i.title}: ${i.body}`).join("\n") : ""),
    );
  },
);

server.tool(
  "get_group_insights",
  "Get insights the engine has surfaced for a project: connections, blind spots, conflicts, patterns, questions, decisions.",
  {
    kind: z.enum(["connection", "blind_spot", "conflict", "pattern", "question", "decision"]).optional(),
    project: projectParam,
  },
  async ({ kind, project }) => {
    const g = resolveGroup(project);
    if (!g) return text("No projects found.");
    touchConnector(g.id, "Claude");
    const ins = listInsights(g.id, kind);
    if (ins.length === 0) return text(`No insights yet for "${g.name}".`);
    return text(ins.map(i => `- [${i.kind}] ${i.title}\n  ${i.body}`).join("\n"));
  },
);

server.tool(
  "list_group_items",
  "List everything a project has shared, newest first.",
  { project: projectParam },
  async ({ project }) => {
    const g = resolveGroup(project);
    if (!g) return text("No projects found.");
    touchConnector(g.id, "Claude");
    const items = listItems(g.id);
    if (items.length === 0) return text(`Nothing shared yet in "${g.name}".`);
    return text(items.map(i =>
      `- [${i.type}] ${i.title}${i.url ? ` (${i.url})` : ""} — ${i.content}`).join("\n"));
  },
);

server.tool(
  "run_analysis",
  "Ask the engine to re-analyze a project and surface new insights.",
  { project: projectParam },
  async ({ project }) => {
    const g = resolveGroup(project);
    if (!g) return text("No projects found.");
    touchConnector(g.id, "Claude");
    const created = await analyzeGroup(g.id).catch(() => []);
    if (!created.length) return text(`Engine is up to date for "${g.name}" — no new insights.`);
    return text(
      `New insights for "${g.name}":\n\n` +
      created.map(i => `[${i.kind}] ${i.title}\n${i.body}`).join("\n\n")
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("GroupWisdom MCP server running on stdio");
