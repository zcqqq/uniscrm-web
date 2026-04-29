# trend-skill — ClawHub Plugin

Aggregates trending topics from social media platforms with semantic search and daily digest.

## Contents

- `skill/SKILL.md` — Skill definition with metadata frontmatter
- `skill/manifest.json` — Commands, integration config, pricing tiers

## MCP Server

URL: `https://trend-skill-dev.zhengchao-qqqqq.workers.dev/mcp`

6 tools: list_platforms, trending_now, search_trends, query_trends, get_trend_detail, get_daily_digest

Authentication: `X-API-Key` header (optional — anonymous tier allows 10 requests/hour).

## Version

0.1.0
