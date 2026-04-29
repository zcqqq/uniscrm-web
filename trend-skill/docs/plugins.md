# Trend Skill — Plugin Installation Guide

The trend skill is available as plugins for multiple AI coding platforms.

## Claude Code

### Install

```
/install-plugin trend-skill
```

After installation, the MCP server is auto-registered. Verify with:

```
/mcp
```

You should see `trend-skill` listed with 6 tools.

### Usage

The plugin provides 6 MCP tools that Claude Code can use automatically. Ask Claude:

- "What's trending on Twitter right now?"
- "Search for AI-related trends"
- "Show me China's trending topics in Chinese"

You can also use the `/trend` slash command:

```
/trend
/trend --location china --language zh
/trend --query "artificial intelligence"
```

## ClawHub

The ClawHub plugin package is at `dist/clawhub-plugin/`. It contains:

- `skill/SKILL.md` — Skill definition with metadata frontmatter
- `skill/manifest.json` — Commands, integration config, pricing tiers

Publish to ClawHub marketplace or distribute the `dist/clawhub-plugin/` directory directly.

## Available MCP Tools

| Tool | Auth | Description |
|------|:----:|-------------|
| `list_platforms` | — | List active trend platforms |
| `trending_now` | — | Get current trending topics (params: location, language, limit) |
| `search_trends` | Required | Semantic search (params: query, platform, location, language, limit) |
| `query_trends` | Required | Filter by metadata (params: platform, location, language, date, limit) |
| `get_trend_detail` | Required | Get full details for a trend by ID |
| `get_daily_digest` | — | Cross-day persistent topics and cross-platform overlap |

## Authentication

- **Anonymous** (no key): 10 requests/hour, only `trending_now`, `list_platforms`, `get_daily_digest`
- **Free** (API key): 30 requests/hour, all tools
- **Premium** (API key): 300 requests/hour, all tools

Pass your API key via the `X-API-Key` header.

## Building from Source

To regenerate plugin packages after modifying `skill/SKILL.md` or `skill/manifest.json`:

```bash
npm run build:plugins

# Or for production URL:
MCP_URL=https://trend-skill.zhengchao-qqqqq.workers.dev/mcp npm run build:plugins
```
