---
name: trend
description: Aggregates trending topics from social media platforms with semantic search and daily digest.
---

# trend

Aggregates trending topics from social media platforms. Query current and historical trends with semantic search.

## MCP Integration (preferred)

MCP server URL: `https://trend-skill-dev.zhengchao-qqqqq.workers.dev/mcp`

The MCP endpoint supports both SSE and plain JSON responses. Use standard JSON-RPC 2.0 over HTTP POST.

Authentication: `X-API-Key` header with API key (optional — anonymous tier allows 10 requests/hour).

### Calling MCP tools via curl

```bash
# Initialize
curl -s -X POST 'https://trend-skill-dev.zhengchao-qqqqq.workers.dev/mcp' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"hermes","version":"1.0"}}}'

# Call trending_now
curl -s -X POST 'https://trend-skill-dev.zhengchao-qqqqq.workers.dev/mcp' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"trending_now","arguments":{"location":"global","language":"en","limit":10}}}'
```

### Available MCP Tools

- **trending_now** — Get current trending topics from cache (fast, no auth required)
  - `location` (string, optional): "global" or "china". Default: "global"
  - `language` (string, optional): "en" or "zh". Default: "en"
  - `limit` (number, optional): Max results. Default: 20

- **search_trends** — Semantic search across trends (requires auth for historical)
  - `query` (string, required): Search query (e.g. "AI", "科技")
  - `platform` (string, optional): Filter by platform
  - `location` (string, optional): Filter by location
  - `language` (string, optional): Filter by language
  - `limit` (number, optional): Max results. Default: 20

- **query_trends** — Filter trends by metadata
  - `platform`, `location`, `language`, `date`, `limit`

- **get_trend_detail** — Get full details for a specific trend by ID

- **get_daily_digest** — Cross-day persistent topics and cross-platform overlap

## /trend

Query trending topics.

### Parameters

- `--query` — Semantic search query (e.g. "AI", "科技")
- `--platform` — Filter by platform (twitter)
- `--location` — Filter by location (global, china). Default: global
- `--language` — Filter by language (en, zh). Default: en
- `--limit` — Max results. Default: 20

### Examples

```
/trend
/trend --location china --language zh
/trend --query "artificial intelligence"
/trend --platform twitter --limit 10
```

## HTTP API (fallback)

Base URL: `https://trend-skill-dev.zhengchao-qqqqq.workers.dev`

**Important:** Cloudflare blocks bot-like User-Agents (e.g. `Python-urllib`). Use `curl` or set a browser User-Agent header.

- `GET /api/trends` — List current trends (query params: platform, location, language, limit)
- `GET /api/trends/search` — Semantic search (query params: query, platform, location, language, limit)
- `GET /health` — Health check

```bash
curl -s 'https://trend-skill-dev.zhengchao-qqqqq.workers.dev/api/trends?location=global&language=en&limit=10'
```
