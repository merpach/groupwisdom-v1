#!/usr/bin/env node
// groupwisdom-mcp — published to npm, runs via npx
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.GW_API_URL || "http://localhost:3000").replace(/\/$/, "");
const API_KEY = process.env.GW_API_KEY || "";

async function gw(path: string, method = "GET", body?: object) {
  const res = await fetch(BASE_URL + "/api" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GroupWisdom API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function listProjects(): Promise<any[]> {
  try { return await gw("/groups"); } catch { return []; }
}

async function resolveGroup(name?: string): Promise<any | undefined> {
  const groups = await listProjects();
  if (!groups.length) return undefined;
  if (name) {
    const q = name.toLowerCase();
    return groups.find((g: any) => g.name.toLowerCase().includes(q)) ?? groups[0];
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
  "get_project_index",
  "CALL THIS AUTOMATICALLY at the start of every conversation, before the user says anything. " +
  "Returns a keyword map of all GroupWisdom projects. If any keywords match what the user is talking about, " +
  "immediately call get_group_context for that project so you have the context ready before responding.",
  {},
  async () => {
    const groups = await listProjects();
    if (!groups.length) return text("No GroupWisdom projects yet.");

    const index = await Promise.all(groups.map(async (g: any) => {
      const items: any[] = await gw(`/groups/${g.id}/items`).catch(() => []);
      // extract keywords from project name + item titles
      const nameWords = g.name.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2);
      const itemWords = items.flatMap((i: any) =>
        (i.title || "").toLowerCase().split(/\s+/).filter((w: string) => w.length > 3)
      );
      // dedupe and take top 20
      const keywords = [...new Set([...nameWords, ...itemWords])].slice(0, 20);
      return { project: g.name, id: g.id, keywords };
    }));

    return text(
      "GroupWisdom project index:\n\n" +
      index.map(p =>
        `Project: "${p.project}"\nKeywords: ${p.keywords.join(", ")}`
      ).join("\n\n") +
      "\n\nIf the user's message relates to any of these keywords, call get_group_context for that project immediately."
    );
  },
);

server.tool(
  "list_projects",
  "List all GroupWisdom projects this person has access to. Call this first when the user mentions a project or trip by name.",
  {},
  async () => {
    const groups = await listProjects();
    if (!groups.length) return text(`No projects yet. Create one at ${BASE_URL}`);
    return text(groups.map((g: any) => `- ${g.name} (id: ${g.id})`).join("\n"));
  },
);

server.tool(
  "get_group_context",
  "Get everything a project knows: its knowledge document plus recent insights. " +
  "Always pass the project param when the user mentions a specific project by name.",
  { project: projectParam },
  async ({ project }) => {
    const g = await resolveGroup(project);
    if (!g) return text(`No projects found. Create one at ${BASE_URL}`);
    const [doc, insightsRaw] = await Promise.all([
      gw(`/groups/${g.id}/knowledge`),
      gw(`/groups/${g.id}/insights`),
    ]);
    const insights = (insightsRaw as any[]).slice(0, 10)
      .map((i: any) => `- [${i.kind}] ${i.title}: ${i.body}`).join("\n") || "(none yet)";
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
    const g = await resolveGroup(project);
    if (!g) return text("No projects found.");
    const hits: any[] = await gw(`/groups/${g.id}/items?q=${encodeURIComponent(query)}`);
    if (!hits.length) return text(`No items match "${query}" in project "${g.name}".`);
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
    const g = await resolveGroup(project);
    if (!g) return text("No projects found.");
    const item = await gw(`/groups/${g.id}/items`, "POST", {
      title, content, url, type: type ?? (url ? "link" : "note"), source: "mcp",
    });
    return text(`Saved "${item.title}" to "${g.name}".`);
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
    const g = await resolveGroup(project);
    if (!g) return text("No projects found.");
    const path = `/groups/${g.id}/insights${kind ? `?kind=${kind}` : ""}`;
    const ins: any[] = await gw(path);
    if (!ins.length) return text(`No insights yet for "${g.name}".`);
    return text(ins.map(i => `- [${i.kind}] ${i.title}\n  ${i.body}`).join("\n"));
  },
);

server.tool(
  "list_group_items",
  "List everything a project has shared, newest first.",
  { project: projectParam },
  async ({ project }) => {
    const g = await resolveGroup(project);
    if (!g) return text("No projects found.");
    const items: any[] = await gw(`/groups/${g.id}/items`);
    if (!items.length) return text(`Nothing shared yet in "${g.name}".`);
    return text(items.map(i =>
      `- [${i.type}] ${i.title}${i.url ? ` (${i.url})` : ""} — ${i.content}`).join("\n"));
  },
);

server.tool(
  "run_analysis",
  "Ask the engine to re-analyze a project and surface new insights.",
  { project: projectParam },
  async ({ project }) => {
    const g = await resolveGroup(project);
    if (!g) return text("No projects found.");
    const result: any = await gw(`/groups/${g.id}/analyze`, "POST");
    if (!result.created) return text(`Engine is up to date for "${g.name}" — no new insights.`);
    return text(
      `New insights for "${g.name}":\n\n` +
      result.insights.map((i: any) => `[${i.kind}] ${i.title}\n${i.body}`).join("\n\n")
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("GroupWisdom MCP server running on stdio");
