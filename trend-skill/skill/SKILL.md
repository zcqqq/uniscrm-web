---
name: trend
description: Aggregate social media trends and generate content based on trending topics
tools:
  - trending_now
  - search_trends
  - query_trends
  - get_trend_detail
  - list_platforms
  - list_formats
  - get_write_context
  - write_from_trend
---

# Trend Skill

Aggregates social media trends from X/Twitter and other platforms. Supports semantic search and AI-powered content generation based on trending topics.

## Commands

### /trend

Query current trending topics.

**Usage:**
- `/trend` — Show top 20 trending topics across all platforms
- `/trend --query "AI"` — Semantic search for AI-related trends
- `/trend --platform twitter` — Show trends from Twitter only
- `/trend --limit 10` — Limit results to 10

**Behavior:**
1. When `--query` is provided, call `search_trends` tool with the query
2. When `--platform` is provided, call `query_trends` tool with the platform filter
3. Otherwise, call `trending_now` tool
4. Display results as a formatted list with title, score, platform, and link

### /write

Generate content based on current trends. Requires premium API key.

**Usage:**
- `/write --format tweet --query "AI"` — Write a tweet about AI trends
- `/write --format article --query "climate"` — Write an article about climate trends
- `/write --format thread --tone casual` — Write a casual tweet thread from top trends
- `/write --format summary` — Write a summary of today's top trends

**Parameters:**
- `--format` (required): tweet, thread, article, summary, headline
- `--query`: Topic to focus on (semantic search)
- `--tone`: Writing tone (default: professional)
- `--locale`: Language/locale (default: zh-CN)
- `--audience`: Target audience (default: general)

**Behavior:**
1. Call `write_from_trend` tool with the provided parameters
2. If the tool returns an error about premium tier, inform the user they need to upgrade
3. If successful, the tool returns a `WriteContext` with a pre-filled prompt template
4. Take the `template` field from the response and use it as the prompt for content generation
5. Generate the content directly in this conversation using the template
6. Output the generated content to the user

## Setup

Configure the MCP server connection in your Claude Code settings:

```json
{
  "mcpServers": {
    "trend": {
      "type": "url",
      "url": "https://trend-skill.your-domain.workers.dev/mcp",
      "headers": {
        "X-API-Key": "${TREND_API_KEY}"
      }
    }
  }
}
```

Set `TREND_API_KEY` environment variable with your API key. Without a key, only free-tier features (/trend) are available.
