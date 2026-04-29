# trend-skill — Claude Code Plugin

Aggregates trending topics from social media platforms with semantic search and daily digest.

## Installation

```
/install-plugin trend-skill
```

Or from a local path:

```
/install-plugin /path/to/trend-skill/dist/claude-code-plugin
```

## MCP Tools

This plugin registers a remote MCP server at `https://trend-skill-dev.zhengchao-qqqqq.workers.dev/mcp` with 6 tools:

| Tool | Auth Required | Description |
|------|:---:|-------------|
| `list_platforms` | No | List active trend platforms |
| `trending_now` | No | Get current trending topics |
| `search_trends` | Yes | Semantic search across trends |
| `query_trends` | Yes | Query trends with metadata filters |
| `get_trend_detail` | Yes | Get full details for a trend by ID |
| `get_daily_digest` | No | Persistent and cross-platform topic digest |

## Authentication

Set the `X-API-Key` header for authenticated access. Without a key, anonymous tier allows 10 requests/hour.

## Version

0.1.0
