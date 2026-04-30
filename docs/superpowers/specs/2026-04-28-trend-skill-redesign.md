# Trend Skill Spec

## Context

Build a "trend" agent skill — the first skill in a multi-skill plugin to be published on ClawHub.ai and other agent skill/plugin marketplaces. The skill aggregates social media trending topics, stores them persistently, and exposes them via MCP tools for AI agents to query.

## Data Model

### Platform

```typescript
type Platform = "twitter" | "weibo" | "douyin" | "baidu";
```

Only Twitter is implemented in this version. The others are reserved for future expansion.

### TrendItem

```typescript
interface TrendItem {
  id: string;              // "{date}:{platform_short}:{location_short}:{sha256(title)[:8]}"
                           // e.g. "2026-04-28:tw:gl:a3f8b2c1"
  platform: Platform;
  location: string;        // "global" | "china"
  language: string;        // "en" | "zh"
  title: string;
  description?: string;
  url?: string;
  score: number;           // normalized 0-100 (percentile)
  metrics: Record<string, number>;
  categories: string[];    // raw platform values (e.g. "Technology", "科学技术")
  timestamp: string;       // ISO 8601
}
```

**ID format**: `{YYYY-MM-DD}:{platform_short}:{location_short}:{sha256(title)[:8]}`

- Deterministic — same day + platform + location + title = same ID (upsert idempotent)
- Different days = different records (preserves history)
- ~30 chars, no encoding issues
- Short codes: tw=twitter, wb=weibo, dy=douyin, bd=baidu; gl=global, cn=china

### Vectorize Metadata

```typescript
{
  platform: string;        // filter ($eq)
  location: string;        // filter ($eq)
  language: string;        // filter ($eq)
  timestamp_ms: number;    // epoch ms, range filter ($gte/$lte), retention cleanup
  date: string;            // "YYYY-MM-DD", exact day filter ($eq)
  categories: string;      // JSON array string
  title: string;           // display without parsing full item
  item: string;            // full TrendItem JSON (keep under 10KB Vectorize limit)
}
```

Embedding text: `title | description | categories` concatenated with ` | `.

Vectorize metadata supports `$eq`/`$ne` on strings and `$gt`/`$gte`/`$lt`/`$lte` on numbers.

## Storage Architecture

### KV — unauthenticated fast path

- Key `trends:latest` → latest snapshot (all platforms/locations)
- Key `trends:{platform}:{location}:latest` → per platform+location snapshot
- No TTL; cron overwrites on each run
- Unauthenticated users read only this layer

### Vectorize — authenticated primary store

- Persistent trend data with semantic search + metadata filtering
- Query patterns:
  - Pure semantic: query vector + topK
  - Semantic + filter: query vector + `filter: { platform, location, ... }`
  - Time range: `timestamp_ms` with `$gte`/`$lte`
  - Category: semantic matching ("科技" matches "Technology" via embedding similarity)
- Retention: configurable via `TREND_RETENTION_DAYS` env var (default 30)
- Cleanup runs in cron after each fetch

### D1 — config only

- `api_keys` table for auth
- No trend data

## Authentication & Rate Limiting

### API Keys

- Format: `sk_trend_<32-char-hex>`
- Stored in D1 `api_keys` table
- Fields: key, tier, owner_name, created_at, expires_at, is_active

### Tiers

| Tier | Rate Limit | Capabilities |
|------|-----------|--------------|
| anonymous | 10 req/hour | Today's trends from KV only |
| free | 30 req/hour | Vectorize queries, semantic search |
| premium | 300 req/hour | Full history, all filters |

### Auth Middleware

- Header: `X-API-Key`
- Missing → anonymous tier
- Invalid → 401
- Deactivated/expired → 403

### Rate Limiter

- KV-based hourly buckets: `ratelimit:{identifier}:{hourBucket}`
- Returns: allowed, remaining, retryAfterSeconds

## Fetch Pipeline

### Cron Schedule

Once daily: `0 0 * * *` (midnight UTC)

### Twitter Source

1. Call `GET /2/trends/by/woeid/{woeid}` for each WOEID:
   - WOEID 1 → location: "global", language: "en"
   - WOEID 23424781 → location: "china", language: "zh"
2. Map API response to TrendItem (title, tweet_count → metrics, categories)
3. Generate deterministic ID
4. Normalize scores via percentile ranking

### TrendSource Interface

```typescript
interface TrendSource {
  platform: Platform;
  fetchTrends(): Promise<TrendItem[]>;
  isAvailable(): Promise<boolean>;
}
```

Extensible for future platforms.

### Aggregator

- Takes TrendSource[] and fetches in parallel
- Collects results, tracks failed sources
- Normalizes scores across all items

### Write Sequence

1. KV: overwrite latest snapshots
2. Vectorize: upsert trend items with embeddings (idempotent by ID)
3. Vectorize: cleanup expired data (> retention days)
4. Push: execute daily digest webhook

## Push / Webhook

### Trigger

Runs as the final step in the cron handler, after all fetch + store operations.

### Digest Logic

1. **Persistent topics**: query Vectorize for yesterday's trends (filter `date` = yesterday). For each, semantic-search today's trends. Similarity >= 0.85 = same topic trending two consecutive days.
2. **Cross-platform topics**: topics in 2+ platforms with similarity >= 0.85. (Reserved — only Twitter now, won't trigger until a second platform is added.)

### Webhook Delivery

POST to `WEBHOOK_URL` env var. Empty URL = push disabled.

**Payload** (Hermes/OpenClaw compatible):

```json
{
  "event": "trend.daily_digest",
  "timestamp": "2026-04-28T00:05:00Z",
  "data": {
    "persistent_topics": [
      {
        "title": "...",
        "platform": "twitter",
        "location": "global",
        "days_trending": 2,
        "current_score": 85,
        "url": "..."
      }
    ],
    "cross_platform_topics": []
  }
}
```

**Security**: HMAC-SHA256 signature in `X-Webhook-Signature` header, using `WEBHOOK_SECRET` env var.

**Failure**: log error, no retry (next daily run will try again).

## Read Paths

### Unauthenticated

- Today's trends only, from KV
- Supports `location`, `language` params (defaults: "global", "en")
- No semantic search, no history

### Authenticated

- Full Vectorize query: semantic search + metadata filters (platform, location, language, time range)
- Category unification via embedding similarity (e.g. query "科技" matches "Technology")
- Personalization via request params: `language` (default "en"), `location` (default "global")

## HTTP API

### Public

- `GET /health` → `{ status: "ok" }`
- `GET /api/trends` → today's trends (query params: location, language, platform, limit)
- `GET /api/trends/search?query=...` → semantic search (auth required)

### Admin (Bearer token: `ADMIN_SECRET`)

- `POST /admin/keys` → create API key
- `GET /admin/keys/:key` → get key info
- `PATCH /admin/keys/:key` → update tier/deactivate
- `DELETE /admin/keys/:key` → delete key

## MCP Server

Exposed at `/mcp` endpoint via WebStandard Streamable HTTP transport.

### Tools

| Tool | Auth Required | Description |
|------|:---:|-------------|
| `list_platforms` | No | List active platforms |
| `trending_now` | No | Top N trends. Params: `location`, `language`, `limit` |
| `query_trends` | Yes | Filter by platform, location, language, time_range, limit |
| `search_trends` | Yes | Semantic search with optional platform/location/language filters |
| `get_trend_detail` | Yes | Single trend by ID |
| `get_daily_digest` | No | Today's persistent + cross-platform topics |

## Skill Definition

### SKILL.md

One command: `/trend`
- Params: `--query`, `--platform`, `--location`, `--language`, `--limit`
- Integration via MCP server URL with X-API-Key header

### manifest.json

- Plugin: first skill in multi-skill plugin
- Two tiers: free (10 req/hour, queries), premium (300 req/hour, full history)
- MCP endpoint with API-key auth

## Environment Separation

### wrangler.toml

```toml
name = "trend-skill"
main = "src/index.ts"
compatibility_date = "2025-04-01"
compatibility_flags = ["nodejs_compat"]

[vars]
TREND_RETENTION_DAYS = "30"

[env.dev]
name = "trend-skill-dev"
kv_namespaces = [{ binding = "TREND_KV", id = "<dev-kv-id>" }]
d1_databases = [{ binding = "TREND_DB", database_name = "trend-skill-db-dev", database_id = "<dev-d1-id>" }]
vectorize = [{ binding = "TREND_VECTORIZE", index_name = "trend-embeddings-dev" }]
[env.dev.triggers]
crons = ["0 0 * * *"]

[env.production]
kv_namespaces = [{ binding = "TREND_KV", id = "<prod-kv-id>" }]
d1_databases = [{ binding = "TREND_DB", database_name = "trend-skill-db", database_id = "<prod-d1-id>" }]
vectorize = [{ binding = "TREND_VECTORIZE", index_name = "trend-embeddings" }]
[env.production.triggers]
crons = ["0 0 * * *"]
```

Deploy: `wrangler deploy --env dev` / `wrangler deploy --env production`

Secrets (per env): `TWITTER_BEARER_TOKEN`, `ADMIN_SECRET`, `WEBHOOK_URL`, `WEBHOOK_SECRET`

### Production Safety

- Never delete or recreate Vectorize indexes in prod
- D1: additive migrations only, never drop tables
- Secrets via `wrangler secret put --env production`

## Project Structure

```
trend-skill/
├── migrations/
│   └── 0001_create_api_keys.sql
├── skill/
│   ├── SKILL.md
│   └── manifest.json
├── src/
│   ├── api/
│   │   ├── admin.ts          # Admin API (key management)
│   │   └── trends.ts         # Public trends API
│   ├── auth/
│   │   ├── keys.ts           # API key CRUD (D1)
│   │   ├── middleware.ts      # Auth resolution
│   │   └── rate-limit.ts     # KV-based rate limiter
│   ├── core/
│   │   ├── aggregator.ts     # Multi-source fetch + normalize
│   │   └── normalizer.ts     # Percentile scoring
│   ├── mcp/
│   │   ├── server.ts         # MCP server + tool definitions
│   │   └── tools.ts          # Tool handler implementations
│   ├── push/
│   │   ├── digest.ts         # Digest logic (persistent/cross-platform detection)
│   │   └── webhook.ts        # Webhook delivery + HMAC signing
│   ├── sources/
│   │   ├── interface.ts      # TrendSource interface
│   │   └── twitter.ts        # Twitter API adapter (multi-WOEID)
│   ├── storage/
│   │   ├── cache.ts          # KV cache (no TTL, overwrite)
│   │   └── vectorize.ts      # Vectorize store (upsert, search, cleanup)
│   ├── index.ts              # Hono app, routes, cron handler
│   └── types.ts              # All type definitions + Env interface
├── tests/                     # Mirrors src/ structure
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── wrangler.toml
```

## Verification

1. `npm test` — all tests pass
2. `wrangler dev --env dev` — health endpoint responds
3. `curl http://localhost:8787/__scheduled` — cron pipeline runs (fetch → store → push)
4. MCP tools via Claude Code — `trending_now`, `search_trends`, `get_daily_digest` return correct data
5. Webhook — set `WEBHOOK_URL` to request bin, verify payload format + HMAC signature
6. Auth — anonymous reads KV, authenticated queries Vectorize, rate limits enforced
