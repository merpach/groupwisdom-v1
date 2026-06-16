# GroupWisdom

**The intelligence layer for groups.** A shared knowledge base, a live insight engine, and a universal connector layer (MCP + REST) so any AI tool can plug into your group's intelligence.

## Quick start

Requires Node 22+ (uses the built-in `node:sqlite` — no native dependencies).

```bash
npm install
npm run build
npm run seed     # optional: demo group "Copenhagen Easter trip"
npm start        # web app at http://localhost:3000
```

The insight engine runs in **mock mode** by default. For real analysis with Claude:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

## What's inside

| Piece | File | What it does |
|---|---|---|
| Storage | `src/db.ts` | SQLite (built-in `node:sqlite`): groups, members, items, insights, connectors, living knowledge doc |
| Insight engine | `src/engine.ts` | Analyzes everything shared; surfaces **connections, blind spots, conflicts, patterns, questions, decisions** and rewrites the group's living markdown doc. Claude API or deterministic mock |
| REST API | `src/api.ts` | Full CRUD for external tools, auth via per-group `X-API-Key` |
| MCP server | `src/mcp.ts` | stdio server: `get_group_context`, `search_group_knowledge`, `save_to_group`, `get_group_insights`, `list_group_items` |
| Web app | `public/index.html` | Insights feed, knowledge base, group page, settings — the demo surface |

The engine runs automatically after every contribution (web, REST, or MCP), and on demand via "Run analysis now".

## Connect Claude (MCP)

Grab the group's API key from **Settings** in the web app, then add to Claude Desktop / Claude Code config:

```json
{
  "mcpServers": {
    "groupwisdom": {
      "command": "node",
      "args": ["/absolute/path/to/groupwisdom/dist/mcp.js"],
      "env": {
        "GW_API_KEY": "gw_...",
        "GW_DB": "/absolute/path/to/groupwisdom/groupwisdom.db"
      }
    }
  }
}
```

Then ask Claude things like *"What restaurants should I look at for our trip?"* (it calls `get_group_context`) or *"Save this to our group"* (it calls `save_to_group`, and the engine immediately checks for new connections).

## REST API

All endpoints under `/api`. External tools authenticate with `X-API-Key: gw_...` and use `-` as the group id.

```bash
# Read the living knowledge document
curl -H "X-API-Key: $KEY" localhost:3000/api/groups/-/knowledge

# Write back to the group
curl -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"title":"Found a great spot","content":"...","type":"note"}' \
  localhost:3000/api/groups/-/items

# Insights (optionally ?kind=blind_spot)
curl -H "X-API-Key: $KEY" localhost:3000/api/groups/-/insights

# Search
curl -H "X-API-Key: $KEY" "localhost:3000/api/groups/-/items?q=tivoli"
```

Other endpoints: `POST /api/groups` (create), `POST /api/groups/:id/members`, `POST /api/groups/:id/analyze`, `POST /api/groups/:id/insights/:iid/react` (`acknowledged`/`dismissed`).

## Environment

| Var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Enables real Claude analysis (otherwise mock) |
| `GW_MODEL` | `claude-sonnet-4-6` | Claude model for the engine |
| `PORT` | `3000` | Web server port |
| `GW_DB` | `groupwisdom.db` | SQLite path |
| `GW_API_KEY` / `GW_GROUP_ID` | first group | Which group the MCP server serves |
