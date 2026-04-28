# trend

Aggregates trending topics from social media platforms. Query current and historical trends with semantic search.

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

## Integration

MCP server URL: `{WORKER_URL}/mcp`

Authentication: `X-API-Key` header with API key.
