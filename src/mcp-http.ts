/**
 * Remote MCP endpoint — mounted at /mcp in the Express server.
 * Speaks the Streamable HTTP transport so Claude.ai connectors work.
 * Auth: ?key=USER_API_KEY in the URL (user's personal API key from their settings).
 * Each request is stateless; a new McpServer is created per-request.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Request, Response } from "express";
import {
  getUserByApiKey,
  getGroupsForUser,
  getGroup,
  listItems,
  listInsights,
  addItem,
  getKnowledgeDoc,
  getProjectSummary,
  touchConnector,
} from "./db.js";
import { analyzeGroup, updateProjectSummary } from "./engine.js";

const projectParam = z.string().optional().describe(
  "Project name (or partial name). If omitted, uses your first project."
);

function buildMcpServer(userId: string) {
  const server = new McpServer({ name: "groupwisdom", version: "1.0.0" });
  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

  function getUserGroups() {
    return getGroupsForUser(userId);
  }

  function resolveGroup(name?: string) {
    const groups = getUserGroups();
    if (!groups.length) return undefined;
    if (name) {
      const q = name.toLowerCase();
      return groups.find(g => g.name.toLowerCase().includes(q)) ?? groups[0];
    }
    return groups[0];
  }

  server.tool(
    "get_project_index",
    "CALL THIS AUTOMATICALLY at the start of every conversation, before the user says anything. " +
    "Returns a keyword map of all GroupWisdom projects. If any keywords match what the user is talking about, " +
    "immediately call get_group_context for that project so you have the context ready before responding.",
    {},
    async () => {
      const groups = getUserGroups();
      if (!groups.length) return text("No GroupWisdom projects yet.");

      const index = groups.map(g => {
        const items = listItems(g.id);
        const summary = getProjectSummary(g.id);
        const nameWords = g.name.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const itemWords = items.flatMap(i =>
          (i.title || "").toLowerCase().split(/\s+/).filter(w => w.length > 3)
        );
        const keywords = [...new Set([...nameWords, ...itemWords])].slice(0, 20);
        return { project: g.name, id: g.id, keywords, summary };
      });

      return text(
        "GroupWisdom project index:\n\n" +
        index.map(p =>
          `Project: "${p.project}"\n` +
          (p.summary ? `Summary: ${p.summary}\n` : "") +
          `Keywords: ${p.keywords.join(", ")}`
        ).join("\n\n") +
        "\n\nIf the user's message relates to any project's summary or keywords, immediately call get_group_context for that project."
      );
    }
  );

  server.tool(
    "list_projects",
    "List all GroupWisdom projects you have access to.",
    {},
    async () => {
      const groups = getUserGroups();
      if (!groups.length) return text("No projects yet.");
      return text(groups.map(g => `- ${g.name} (id: ${g.id})`).join("\n"));
    }
  );

  server.tool(
    "get_group_context",
    "Get everything a project knows: its knowledge document plus recent insights.",
    { project: projectParam },
    async ({ project }) => {
      const g = resolveGroup(project);
      if (!g) return text("No projects found.");
      const doc = getKnowledgeDoc(g.id);
      const insights = listInsights(g.id).slice(0, 10)
        .map(i => `- [${i.kind}] ${i.title}: ${i.body}`).join("\n") || "(none yet)";
      return text(`# Project: ${g.name}\n\n## Knowledge base\n${doc.markdown}\n\n## Recent insights\n${insights}`);
    }
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
      const items = listItems(g.id);
      const q = query.toLowerCase();
      const hits = items.filter(i =>
        (i.title + " " + i.content + " " + (i.url || "")).toLowerCase().includes(q)
      );
      if (!hits.length) return text(`No items match "${query}" in project "${g.name}".`);
      return text(hits.map(h =>
        `- [${h.type}] ${h.title}${h.url ? ` (${h.url})` : ""}\n  ${h.content}`).join("\n"));
    }
  );

  server.tool(
    "save_to_group",
    "Save something to a project's shared knowledge base. The insight engine immediately checks for new connections.",
    {
      title: z.string().describe("Short title"),
      content: z.string().describe("The content or context to save"),
      url: z.string().optional().describe("Optional URL"),
      type: z.enum(["link", "note", "file", "thought"]).optional(),
      project: projectParam,
    },
    async ({ title, content, url, type, project }) => {
      const g = resolveGroup(project);
      if (!g) return text("No projects found.");
      const item = addItem(g.id, {
        title, content, url, type: type ?? (url ? "link" : "note"), source: "mcp",
        member_id: null,
      });
      touchConnector(g.id, "Claude");
      analyzeGroup(g.id).catch(() => {});
      updateProjectSummary(g.id).catch(() => {});
      return text(`Saved "${item.title}" to "${g.name}".`);
    }
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
      const ins = listInsights(g.id, kind);
      if (!ins.length) return text(`No insights yet for "${g.name}".`);
      return text(ins.map(i => `- [${i.kind}] ${i.title}\n  ${i.body}`).join("\n"));
    }
  );

  server.tool(
    "list_group_items",
    "List everything a project has shared, newest first.",
    { project: projectParam },
    async ({ project }) => {
      const g = resolveGroup(project);
      if (!g) return text("No projects found.");
      const items = listItems(g.id);
      if (!items.length) return text(`Nothing shared yet in "${g.name}".`);
      return text(items.map(i =>
        `- [${i.type}] ${i.title}${i.url ? ` (${i.url})` : ""} — ${i.content}`).join("\n"));
    }
  );

  server.tool(
    "run_analysis",
    "Ask the engine to re-analyze a project and surface new insights.",
    { project: projectParam },
    async ({ project }) => {
      const g = resolveGroup(project);
      if (!g) return text("No projects found.");
      const result = await analyzeGroup(g.id);
      if (!result.length) return text(`Engine is up to date for "${g.name}" — no new insights.`);
      return text(
        `New insights for "${g.name}":\n\n` +
        result.map(i => `[${i.kind}] ${i.title}\n${i.body}`).join("\n\n")
      );
    }
  );

  return server;
}

export async function handleMcpRequest(req: Request, res: Response) {
  // Auth: ?key=USER_API_KEY or Authorization: Bearer USER_API_KEY
  const apiKey =
    (req.query.key as string) ||
    req.headers.authorization?.replace(/^Bearer\s+/i, "");

  if (!apiKey) {
    res.status(401).json({ error: "Missing API key. Add ?key=YOUR_KEY to the MCP URL." });
    return;
  }

  const user = getUserByApiKey(apiKey);
  if (!user) {
    res.status(401).json({ error: "Invalid API key." });
    return;
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildMcpServer(user.id);
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
