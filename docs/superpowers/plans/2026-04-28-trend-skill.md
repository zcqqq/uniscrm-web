# Trend Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Cloudflare Worker "trend" agent skill that aggregates Twitter trending topics, stores them in KV + Vectorize, and exposes them via HTTP API + MCP server with auth, rate limiting, and daily webhook push.

**Architecture:** Hono HTTP framework on Cloudflare Workers. KV for unauthenticated fast reads, Vectorize for persistent semantic search, D1 for API key auth. Daily cron fetches Twitter trends for global + China, normalizes scores, stores data, detects persistent topics, and pushes a digest webhook.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers (KV, D1, Vectorize, AI), MCP SDK (`@modelcontextprotocol/sdk`), Vitest with `@cloudflare/vitest-pool-workers`, Zod

---

## File Structure

```
trend-skill/
├── migrations/
│   └── 0001_create_api_keys.sql    # D1 schema for API keys
├── skill/
│   ├── SKILL.md                    # Claude Code skill definition
│   └── manifest.json               # ClawHub plugin manifest
├── src/
│   ├── types.ts                    # All types: Platform, TrendItem, Env, etc.
│   ├── sources/
│   │   ├── interface.ts            # TrendSource interface
│   │   └── twitter.ts              # Twitter API adapter (multi-WOEID)
│   ├── core/
│   │   ├── normalizer.ts           # Percentile-based score normalization
│   │   └── aggregator.ts           # Multi-source parallel fetch + normalize
│   ├── storage/
│   │   ├── cache.ts                # KV cache (no TTL, overwrite)
│   │   └── vectorize.ts            # Vectorize store (upsert, search, cleanup)
│   ├── auth/
│   │   ├── keys.ts                 # API key CRUD on D1
│   │   ├── middleware.ts           # Auth resolution middleware
│   │   └── rate-limit.ts           # KV-based hourly rate limiter
│   ├── api/
│   │   ├── trends.ts               # Public trends API routes
│   │   └── admin.ts                # Admin key management routes
│   ├── push/
│   │   ├── digest.ts               # Persistent/cross-platform topic detection
│   │   └── webhook.ts              # HMAC-signed webhook delivery
│   ├── mcp/
│   │   ├── server.ts               # MCP server factory + tool registration
│   │   └── tools.ts                # MCP tool handler implementations
│   └── index.ts                    # Hono app, route wiring, cron handler, MCP endpoint
├── tests/
│   ├── sources/
│   │   └── twitter.test.ts
│   ├── core/
│   │   ├── normalizer.test.ts
│   │   └── aggregator.test.ts
│   ├── storage/
│   │   ├── cache.test.ts
│   │   └── vectorize.test.ts
│   ├── auth/
│   │   ├── keys.test.ts
│   │   ├── middleware.test.ts
│   │   └── rate-limit.test.ts
│   ├── api/
│   │   ├── trends.test.ts
│   │   └── admin.test.ts
│   ├── push/
│   │   ├── digest.test.ts
│   │   └── webhook.test.ts
│   └── mcp/
│       └── tools.test.ts
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── wrangler.toml
```

---

## Task 1: Project Scaffold

**Files:**
- Create: `trend-skill/package.json`
- Create: `trend-skill/tsconfig.json`
- Create: `trend-skill/vitest.config.ts`
- Create: `trend-skill/wrangler.toml`
- Create: `trend-skill/migrations/0001_create_api_keys.sql`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "trend-skill",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev --env dev",
    "deploy:dev": "wrangler deploy --env dev",
    "deploy:prod": "wrangler deploy --env production",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "hono": "^4.7.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.8.0",
    "@cloudflare/workers-types": "^4.20250410.0",
    "typescript": "^5.8.0",
    "vitest": "^3.1.0",
    "wrangler": "^4.10.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "types": ["@cloudflare/workers-types/2023-07-01", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml", environment: "dev" },
      },
    },
  },
});
```

- [ ] **Step 4: Create wrangler.toml**

```toml
name = "trend-skill"
main = "src/index.ts"
compatibility_date = "2025-04-01"
compatibility_flags = ["nodejs_compat"]

[vars]
TREND_RETENTION_DAYS = "30"

[env.dev]
name = "trend-skill-dev"

[[env.dev.kv_namespaces]]
binding = "TREND_KV"
id = "<dev-kv-id>"

[[env.dev.d1_databases]]
binding = "TREND_DB"
database_name = "trend-skill-db-dev"
database_id = "<dev-d1-id>"

[[env.dev.vectorize]]
binding = "TREND_VECTORIZE"
index_name = "trend-embeddings-dev"

[env.dev.ai]
binding = "AI"

[env.dev.triggers]
crons = ["0 0 * * *"]

[env.production]
name = "trend-skill"

[[env.production.kv_namespaces]]
binding = "TREND_KV"
id = "<prod-kv-id>"

[[env.production.d1_databases]]
binding = "TREND_DB"
database_name = "trend-skill-db"
database_id = "<prod-d1-id>"

[[env.production.vectorize]]
binding = "TREND_VECTORIZE"
index_name = "trend-embeddings"

[env.production.ai]
binding = "AI"

[env.production.triggers]
crons = ["0 0 * * *"]
```

- [ ] **Step 5: Create D1 migration**

Create `trend-skill/migrations/0001_create_api_keys.sql`:

```sql
CREATE TABLE IF NOT EXISTS api_keys (
  key TEXT PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'free',
  owner_name TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_api_keys_tier ON api_keys(tier);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);
```

- [ ] **Step 6: Install dependencies**

Run: `cd trend-skill && npm install`
Expected: `node_modules/` created, `package-lock.json` generated, no errors.

- [ ] **Step 7: Verify TypeScript compiles**

Run: `cd trend-skill && npx tsc --noEmit`
Expected: no output (no source files yet, no errors).

- [ ] **Step 8: Commit**

```bash
git add trend-skill/package.json trend-skill/package-lock.json trend-skill/tsconfig.json trend-skill/vitest.config.ts trend-skill/wrangler.toml trend-skill/migrations/
git commit -m "feat(trend): scaffold project with wrangler, vitest, and D1 migration"
```

---

## Task 2: Types

**Files:**
- Create: `trend-skill/src/types.ts`

- [ ] **Step 1: Create types.ts**

```typescript
export type Platform = "twitter" | "weibo" | "douyin" | "baidu";

export type Tier = "anonymous" | "free" | "premium";

export interface TrendItem {
  id: string;
  platform: Platform;
  location: string;
  language: string;
  title: string;
  description?: string;
  url?: string;
  score: number;
  metrics: Record<string, number>;
  categories: string[];
  timestamp: string;
}

export interface TrendSearchResult {
  item: TrendItem;
  similarity: number;
}

export interface AggregatorResult {
  items: TrendItem[];
  failedPlatforms: Platform[];
}

export interface AuthResult {
  tier: Tier;
  identifier: string;
}

export interface AuthError {
  error: string;
  status: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds?: number;
}

export interface DigestPayload {
  event: "trend.daily_digest";
  timestamp: string;
  data: {
    persistent_topics: PersistentTopic[];
    cross_platform_topics: CrossPlatformTopic[];
  };
}

export interface PersistentTopic {
  title: string;
  platform: string;
  location: string;
  days_trending: number;
  current_score: number;
  url?: string;
}

export interface CrossPlatformTopic {
  title: string;
  platforms: string[];
  location: string;
  similarity: number;
  url?: string;
}

export interface Env {
  TREND_KV: KVNamespace;
  TREND_DB: D1Database;
  TREND_VECTORIZE: VectorizeIndex;
  AI: Ai;
  TWITTER_BEARER_TOKEN: string;
  ADMIN_SECRET: string;
  WEBHOOK_URL: string;
  WEBHOOK_SECRET: string;
  TREND_RETENTION_DAYS: string;
}

export const PLATFORM_SHORT: Record<Platform, string> = {
  twitter: "tw",
  weibo: "wb",
  douyin: "dy",
  baidu: "bd",
};

export const LOCATION_SHORT: Record<string, string> = {
  global: "gl",
  china: "cn",
};

export const TIER_RATE_LIMITS: Record<Tier, number> = {
  anonymous: 10,
  free: 30,
  premium: 300,
};
```

- [ ] **Step 2: Verify typecheck**

Run: `cd trend-skill && npx tsc --noEmit`
Expected: pass (no errors).

- [ ] **Step 3: Commit**

```bash
git add trend-skill/src/types.ts
git commit -m "feat(trend): add type definitions"
```

---

## Task 3: Normalizer

**Files:**
- Create: `trend-skill/src/core/normalizer.ts`
- Create: `trend-skill/tests/core/normalizer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `trend-skill/tests/core/normalizer.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { normalizeScores } from "../../src/core/normalizer";
import type { TrendItem } from "../../src/types";

function makeTrend(title: string, score: number): TrendItem {
  return {
    id: `2026-04-28:tw:gl:${title}`,
    platform: "twitter",
    location: "global",
    language: "en",
    title,
    score,
    metrics: { tweet_volume: score },
    categories: [],
    timestamp: "2026-04-28T00:00:00Z",
  };
}

describe("normalizeScores", () => {
  it("returns empty array for empty input", () => {
    expect(normalizeScores([])).toEqual([]);
  });

  it("assigns 100 to single item", () => {
    const items = [makeTrend("a", 500)];
    const result = normalizeScores(items);
    expect(result[0].score).toBe(100);
  });

  it("assigns percentile scores sorted descending", () => {
    const items = [makeTrend("low", 10), makeTrend("mid", 50), makeTrend("high", 100)];
    const result = normalizeScores(items);
    expect(result[0].title).toBe("high");
    expect(result[0].score).toBe(100);
    expect(result[1].title).toBe("mid");
    expect(result[1].score).toBeGreaterThan(0);
    expect(result[1].score).toBeLessThan(100);
    expect(result[2].title).toBe("low");
  });

  it("handles tied scores", () => {
    const items = [makeTrend("a", 50), makeTrend("b", 50), makeTrend("c", 100)];
    const result = normalizeScores(items);
    expect(result[0].score).toBe(100);
    expect(result[1].score).toBe(result[2].score);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd trend-skill && npx vitest run tests/core/normalizer.test.ts`
Expected: FAIL — cannot find module `../../src/core/normalizer`.

- [ ] **Step 3: Write minimal implementation**

Create `trend-skill/src/core/normalizer.ts`:

```typescript
import type { TrendItem } from "../types";

export function normalizeScores(items: TrendItem[]): TrendItem[] {
  if (items.length === 0) return [];
  if (items.length === 1) return [{ ...items[0], score: 100 }];

  const sorted = [...items].sort((a, b) => b.score - a.score || b.timestamp.localeCompare(a.timestamp));
  const n = sorted.length;

  return sorted.map((item, i) => {
    const rank = i;
    const percentile = Math.round(((n - 1 - rank) / (n - 1)) * 100);
    return { ...item, score: percentile };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd trend-skill && npx vitest run tests/core/normalizer.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add trend-skill/src/core/normalizer.ts trend-skill/tests/core/normalizer.test.ts
git commit -m "feat(trend): add percentile score normalizer"
```

---

## Task 4: Twitter Source + ID Generation

**Files:**
- Create: `trend-skill/src/sources/interface.ts`
- Create: `trend-skill/src/sources/twitter.ts`
- Create: `trend-skill/tests/sources/twitter.test.ts`

- [ ] **Step 1: Create TrendSource interface**

Create `trend-skill/src/sources/interface.ts`:

```typescript
import type { Platform, TrendItem } from "../types";

export interface TrendSource {
  platform: Platform;
  fetchTrends(): Promise<TrendItem[]>;
  isAvailable(): Promise<boolean>;
}
```

- [ ] **Step 2: Write the failing test**

Create `trend-skill/tests/sources/twitter.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TwitterTrendSource, generateTrendId } from "../../src/sources/twitter";

describe("generateTrendId", () => {
  it("produces deterministic ID from date+platform+location+title", () => {
    const id1 = generateTrendId("2026-04-28", "twitter", "global", "AI Revolution");
    const id2 = generateTrendId("2026-04-28", "twitter", "global", "AI Revolution");
    expect(id1).toBe(id2);
  });

  it("follows format date:platform_short:location_short:hash8", () => {
    const id = generateTrendId("2026-04-28", "twitter", "global", "Test Topic");
    expect(id).toMatch(/^2026-04-28:tw:gl:[a-f0-9]{8}$/);
  });

  it("different titles produce different IDs", () => {
    const id1 = generateTrendId("2026-04-28", "twitter", "global", "Topic A");
    const id2 = generateTrendId("2026-04-28", "twitter", "global", "Topic B");
    expect(id1).not.toBe(id2);
  });

  it("different days produce different IDs", () => {
    const id1 = generateTrendId("2026-04-28", "twitter", "global", "Same Topic");
    const id2 = generateTrendId("2026-04-29", "twitter", "global", "Same Topic");
    expect(id1).not.toBe(id2);
  });
});

describe("TwitterTrendSource", () => {
  const WOEID_CONFIGS = [
    { woeid: 1, location: "global", language: "en" },
    { woeid: 23424781, location: "china", language: "zh" },
  ] as const;

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("fetches trends for all WOEIDs and maps to TrendItems", async () => {
    const mockResponse = (trends: object[]) => ({
      ok: true,
      json: () => Promise.resolve(trends),
    });

    fetchMock
      .mockResolvedValueOnce(
        mockResponse([
          { trend_name: "AI Revolution", tweet_count: 50000, trend_url: "https://x.com/trend/1" },
          { trend_name: "Climate Summit", tweet_count: 30000, trend_url: "https://x.com/trend/2" },
        ])
      )
      .mockResolvedValueOnce(
        mockResponse([
          { trend_name: "人工智能", tweet_count: 40000, trend_url: "https://x.com/trend/3" },
        ])
      );

    const source = new TwitterTrendSource("test-bearer-token");
    const items = await source.fetchTrends();

    expect(items).toHaveLength(3);
    expect(items[0].platform).toBe("twitter");
    expect(items[0].location).toBe("global");
    expect(items[0].language).toBe("en");
    expect(items[0].title).toBe("AI Revolution");
    expect(items[0].metrics.tweet_volume).toBe(50000);

    expect(items[2].location).toBe("china");
    expect(items[2].language).toBe("zh");
    expect(items[2].title).toBe("人工智能");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.x.com/2/trends/by/woeid/1",
      expect.objectContaining({
        headers: { Authorization: "Bearer test-bearer-token" },
      })
    );
  });

  it("returns empty array when API fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, statusText: "Too Many Requests" });

    const source = new TwitterTrendSource("test-token");
    const items = await source.fetchTrends();
    expect(items).toEqual([]);
  });

  it("isAvailable returns true when token is non-empty", async () => {
    const source = new TwitterTrendSource("some-token");
    expect(await source.isAvailable()).toBe(true);
  });

  it("isAvailable returns false when token is empty", async () => {
    const source = new TwitterTrendSource("");
    expect(await source.isAvailable()).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd trend-skill && npx vitest run tests/sources/twitter.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 4: Write implementation**

Create `trend-skill/src/sources/twitter.ts`:

```typescript
import type { Platform, TrendItem } from "../types";
import { PLATFORM_SHORT, LOCATION_SHORT } from "../types";
import type { TrendSource } from "./interface";

const WOEID_CONFIGS = [
  { woeid: 1, location: "global", language: "en" },
  { woeid: 23424781, location: "china", language: "zh" },
] as const;

export function generateTrendId(
  date: string,
  platform: Platform,
  location: string,
  title: string
): string {
  const encoder = new TextEncoder();
  const data = encoder.encode(title);
  const hashArray = new Uint8Array(32);
  let h = 0x811c9dc5;
  for (const byte of data) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  const ps = PLATFORM_SHORT[platform];
  const ls = LOCATION_SHORT[location] ?? location.slice(0, 2);
  return `${date}:${ps}:${ls}:${hex}`;
}

export class TwitterTrendSource implements TrendSource {
  platform: Platform = "twitter";

  constructor(private bearerToken: string) {}

  async fetchTrends(): Promise<TrendItem[]> {
    const today = new Date().toISOString().slice(0, 10);
    const allItems: TrendItem[] = [];

    for (const config of WOEID_CONFIGS) {
      try {
        const response = await fetch(
          `https://api.x.com/2/trends/by/woeid/${config.woeid}`,
          { headers: { Authorization: `Bearer ${this.bearerToken}` } }
        );

        if (!response.ok) continue;

        const trends: { trend_name: string; tweet_count: number; trend_url?: string }[] =
          await response.json();

        for (const trend of trends) {
          const id = generateTrendId(today, "twitter", config.location, trend.trend_name);
          allItems.push({
            id,
            platform: "twitter",
            location: config.location,
            language: config.language,
            title: trend.trend_name,
            url: trend.trend_url,
            score: trend.tweet_count ?? 0,
            metrics: { tweet_volume: trend.tweet_count ?? 0 },
            categories: [],
            timestamp: new Date().toISOString(),
          });
        }
      } catch {
        continue;
      }
    }

    return allItems;
  }

  async isAvailable(): Promise<boolean> {
    return this.bearerToken.length > 0;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd trend-skill && npx vitest run tests/sources/twitter.test.ts`
Expected: all tests PASS.

Note: the ID test checks `[a-f0-9]{8}` hex pattern. The FNV-1a hash produces a deterministic 8-char hex. If the exact pattern doesn't match (e.g. uppercase), adjust the regex or the hash output. The key property is determinism.

- [ ] **Step 6: Commit**

```bash
git add trend-skill/src/sources/interface.ts trend-skill/src/sources/twitter.ts trend-skill/tests/sources/twitter.test.ts
git commit -m "feat(trend): add Twitter source with multi-WOEID and deterministic IDs"
```

---

## Task 5: Aggregator

**Files:**
- Create: `trend-skill/src/core/aggregator.ts`
- Create: `trend-skill/tests/core/aggregator.test.ts`

- [ ] **Step 1: Write the failing test**

Create `trend-skill/tests/core/aggregator.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { Aggregator } from "../../src/core/aggregator";
import type { TrendSource } from "../../src/sources/interface";
import type { TrendItem, Platform } from "../../src/types";

function makeSource(platform: Platform, items: TrendItem[], available = true): TrendSource {
  return {
    platform,
    fetchTrends: () => Promise.resolve(items),
    isAvailable: () => Promise.resolve(available),
  };
}

function makeTrend(platform: Platform, title: string, score: number): TrendItem {
  return {
    id: `2026-04-28:tw:gl:${title}`,
    platform,
    location: "global",
    language: "en",
    title,
    score,
    metrics: {},
    categories: [],
    timestamp: "2026-04-28T00:00:00Z",
  };
}

describe("Aggregator", () => {
  it("fetches from all available sources and normalizes", async () => {
    const source = makeSource("twitter", [
      makeTrend("twitter", "Topic A", 100),
      makeTrend("twitter", "Topic B", 50),
    ]);
    const agg = new Aggregator([source]);
    const result = await agg.fetchAll();

    expect(result.items).toHaveLength(2);
    expect(result.items[0].score).toBe(100);
    expect(result.items[1].score).toBe(0);
    expect(result.failedPlatforms).toEqual([]);
  });

  it("skips unavailable sources and records them as failed", async () => {
    const source = makeSource("twitter", [], false);
    const agg = new Aggregator([source]);
    const result = await agg.fetchAll();

    expect(result.items).toEqual([]);
    expect(result.failedPlatforms).toEqual(["twitter"]);
  });

  it("catches source errors and records platform as failed", async () => {
    const source: TrendSource = {
      platform: "twitter",
      fetchTrends: () => Promise.reject(new Error("API down")),
      isAvailable: () => Promise.resolve(true),
    };
    const agg = new Aggregator([source]);
    const result = await agg.fetchAll();

    expect(result.items).toEqual([]);
    expect(result.failedPlatforms).toEqual(["twitter"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd trend-skill && npx vitest run tests/core/aggregator.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write implementation**

Create `trend-skill/src/core/aggregator.ts`:

```typescript
import type { TrendItem, AggregatorResult, Platform } from "../types";
import type { TrendSource } from "../sources/interface";
import { normalizeScores } from "./normalizer";

export class Aggregator {
  constructor(private sources: TrendSource[]) {}

  async fetchAll(): Promise<AggregatorResult> {
    const allItems: TrendItem[] = [];
    const failedPlatforms: Platform[] = [];

    const results = await Promise.allSettled(
      this.sources.map(async (source) => {
        if (!(await source.isAvailable())) {
          failedPlatforms.push(source.platform);
          return [];
        }
        return source.fetchTrends();
      })
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        allItems.push(...result.value);
      } else {
        failedPlatforms.push(this.sources[i].platform);
      }
    }

    return {
      items: normalizeScores(allItems),
      failedPlatforms,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd trend-skill && npx vitest run tests/core/aggregator.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add trend-skill/src/core/aggregator.ts trend-skill/tests/core/aggregator.test.ts
git commit -m "feat(trend): add aggregator with parallel fetch and normalization"
```

---

## Task 6: KV Cache

**Files:**
- Create: `trend-skill/src/storage/cache.ts`
- Create: `trend-skill/tests/storage/cache.test.ts`

- [ ] **Step 1: Write the failing test**

Create `trend-skill/tests/storage/cache.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { TrendCache } from "../../src/storage/cache";
import type { TrendItem } from "../../src/types";

function makeTrend(title: string, platform = "twitter", location = "global"): TrendItem {
  return {
    id: `2026-04-28:tw:gl:${title}`,
    platform: platform as TrendItem["platform"],
    location,
    language: "en",
    title,
    score: 50,
    metrics: {},
    categories: [],
    timestamp: "2026-04-28T00:00:00Z",
  };
}

const makeKvMock = () => {
  const store = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => { store.set(key, value); return Promise.resolve(); },
    _store: store,
  } as unknown as KVNamespace;
};

describe("TrendCache", () => {
  let kv: KVNamespace;
  let cache: TrendCache;

  beforeEach(() => {
    kv = makeKvMock();
    cache = new TrendCache(kv);
  });

  it("setLatest and getLatest round-trip", async () => {
    const items = [makeTrend("A"), makeTrend("B")];
    await cache.setLatest(items);
    const result = await cache.getLatest();
    expect(result).toEqual(items);
  });

  it("getLatest returns null when empty", async () => {
    expect(await cache.getLatest()).toBeNull();
  });

  it("setPlatformLatest and getPlatformLatest round-trip", async () => {
    const items = [makeTrend("X", "twitter", "china")];
    await cache.setPlatformLatest("twitter", "china", items);
    const result = await cache.getPlatformLatest("twitter", "china");
    expect(result).toEqual(items);
  });

  it("overwrites on second set (no TTL)", async () => {
    await cache.setLatest([makeTrend("old")]);
    await cache.setLatest([makeTrend("new")]);
    const result = await cache.getLatest();
    expect(result).toHaveLength(1);
    expect(result![0].title).toBe("new");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd trend-skill && npx vitest run tests/storage/cache.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write implementation**

Create `trend-skill/src/storage/cache.ts`:

```typescript
import type { TrendItem } from "../types";

export class TrendCache {
  constructor(private kv: KVNamespace) {}

  async getLatest(): Promise<TrendItem[] | null> {
    const raw = await this.kv.get("trends:latest");
    return raw ? JSON.parse(raw) : null;
  }

  async setLatest(items: TrendItem[]): Promise<void> {
    await this.kv.put("trends:latest", JSON.stringify(items));
  }

  async getPlatformLatest(platform: string, location: string): Promise<TrendItem[] | null> {
    const raw = await this.kv.get(`trends:${platform}:${location}:latest`);
    return raw ? JSON.parse(raw) : null;
  }

  async setPlatformLatest(platform: string, location: string, items: TrendItem[]): Promise<void> {
    await this.kv.put(`trends:${platform}:${location}:latest`, JSON.stringify(items));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd trend-skill && npx vitest run tests/storage/cache.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add trend-skill/src/storage/cache.ts trend-skill/tests/storage/cache.test.ts
git commit -m "feat(trend): add KV cache with no-TTL overwrite strategy"
```

---

## Task 7: Vectorize Store

**Files:**
- Create: `trend-skill/src/storage/vectorize.ts`
- Create: `trend-skill/tests/storage/vectorize.test.ts`

- [ ] **Step 1: Write the failing test**

Create `trend-skill/tests/storage/vectorize.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TrendVectorStore } from "../../src/storage/vectorize";
import type { TrendItem } from "../../src/types";

function makeTrend(title: string, date = "2026-04-28"): TrendItem {
  return {
    id: `${date}:tw:gl:abc12345`,
    platform: "twitter",
    location: "global",
    language: "en",
    title,
    score: 80,
    metrics: {},
    categories: ["Technology"],
    timestamp: `${date}T00:00:00Z`,
  };
}

describe("TrendVectorStore", () => {
  let vectorize: any;
  let ai: any;
  let store: TrendVectorStore;

  beforeEach(() => {
    vectorize = {
      upsert: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({ matches: [] }),
      deleteByIds: vi.fn().mockResolvedValue(undefined),
    };
    ai = {
      run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2, 0.3]] }),
    };
    store = new TrendVectorStore(vectorize, ai);
  });

  describe("buildEmbeddingText", () => {
    it("concatenates title, description, and categories", () => {
      const item = { ...makeTrend("AI"), description: "Artificial intelligence", categories: ["Tech", "Science"] };
      expect(store.buildEmbeddingText(item)).toBe("AI | Artificial intelligence | Tech, Science");
    });

    it("omits missing optional fields", () => {
      const item = makeTrend("AI");
      item.categories = [];
      expect(store.buildEmbeddingText(item)).toBe("AI");
    });
  });

  describe("upsertTrends", () => {
    it("generates embeddings and upserts with metadata", async () => {
      const items = [makeTrend("AI Topic")];
      ai.run.mockResolvedValue({ data: [[0.1, 0.2, 0.3]] });

      await store.upsertTrends(items);

      expect(ai.run).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", { text: ["AI Topic | Technology"] });
      expect(vectorize.upsert).toHaveBeenCalledWith([
        expect.objectContaining({
          id: items[0].id,
          values: [0.1, 0.2, 0.3],
          metadata: expect.objectContaining({
            platform: "twitter",
            location: "global",
            language: "en",
            date: "2026-04-28",
            title: "AI Topic",
          }),
        }),
      ]);
    });

    it("skips empty array", async () => {
      await store.upsertTrends([]);
      expect(ai.run).not.toHaveBeenCalled();
    });
  });

  describe("search", () => {
    it("embeds query and returns matched items with similarity", async () => {
      const item = makeTrend("Result");
      ai.run.mockResolvedValue({ data: [[0.5, 0.5, 0.5]] });
      vectorize.query.mockResolvedValue({
        matches: [{ id: item.id, score: 0.92, metadata: { item: JSON.stringify(item) } }],
      });

      const results = await store.search("test query");

      expect(results).toHaveLength(1);
      expect(results[0].item.title).toBe("Result");
      expect(results[0].similarity).toBe(0.92);
    });

    it("passes filters to vectorize query", async () => {
      ai.run.mockResolvedValue({ data: [[0.5, 0.5, 0.5]] });
      vectorize.query.mockResolvedValue({ matches: [] });

      await store.search("test", 10, { platform: "twitter", location: "china" });

      expect(vectorize.query).toHaveBeenCalledWith(
        [0.5, 0.5, 0.5],
        expect.objectContaining({
          filter: { platform: "twitter", location: "china" },
        })
      );
    });
  });

  describe("cleanupOld", () => {
    it("deletes vectors older than retention days", async () => {
      const oldTimestamp = Date.now() - 31 * 24 * 60 * 60 * 1000;
      const oldItem = { ...makeTrend("Old"), timestamp: new Date(oldTimestamp).toISOString() };

      vectorize.query.mockResolvedValue({
        matches: [
          { id: "old-id", score: 0, metadata: { item: JSON.stringify(oldItem), timestamp_ms: oldTimestamp } },
        ],
      });

      await store.cleanupOld(30);

      expect(vectorize.deleteByIds).toHaveBeenCalledWith(["old-id"]);
    });

    it("skips deletion when nothing is expired", async () => {
      const recentItem = makeTrend("Recent");
      vectorize.query.mockResolvedValue({
        matches: [
          { id: "recent-id", score: 0, metadata: { item: JSON.stringify(recentItem), timestamp_ms: Date.now() } },
        ],
      });

      await store.cleanupOld(30);

      expect(vectorize.deleteByIds).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd trend-skill && npx vitest run tests/storage/vectorize.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write implementation**

Create `trend-skill/src/storage/vectorize.ts`:

```typescript
import type { TrendItem, TrendSearchResult } from "../types";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export class TrendVectorStore {
  constructor(
    private vectorize: VectorizeIndex,
    private ai: Ai
  ) {}

  buildEmbeddingText(item: TrendItem): string {
    const parts = [item.title];
    if (item.description) parts.push(item.description);
    if (item.categories.length > 0) parts.push(item.categories.join(", "));
    return parts.join(" | ");
  }

  async upsertTrends(items: TrendItem[]): Promise<void> {
    if (items.length === 0) return;

    const texts = items.map((item) => this.buildEmbeddingText(item));
    const embedResult = (await this.ai.run(EMBEDDING_MODEL, { text: texts })) as { data: number[][] };

    const records = items.map((item, i) => ({
      id: item.id,
      values: embedResult.data[i],
      metadata: {
        platform: item.platform,
        location: item.location,
        language: item.language,
        timestamp_ms: new Date(item.timestamp).getTime(),
        date: item.timestamp.slice(0, 10),
        categories: JSON.stringify(item.categories),
        title: item.title,
        item: JSON.stringify(item),
      },
    }));

    await this.vectorize.upsert(records);
  }

  async search(
    query: string,
    limit = 20,
    filter?: Record<string, string | number>
  ): Promise<TrendSearchResult[]> {
    const cappedLimit = Math.min(limit, 50);
    const embedResult = (await this.ai.run(EMBEDDING_MODEL, { text: [query] })) as { data: number[][] };

    const options: VectorizeQueryOptions = {
      topK: cappedLimit,
      returnMetadata: "all",
    };
    if (filter) {
      options.filter = filter;
    }

    const matches = await this.vectorize.query(embedResult.data[0], options);

    return matches.matches.map((m) => ({
      item: JSON.parse(m.metadata!.item as string) as TrendItem,
      similarity: m.score,
    }));
  }

  async cleanupOld(retentionDays: number): Promise<void> {
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    const allResults = await this.vectorize.query(new Array(768).fill(0), {
      topK: 100,
      returnMetadata: "all",
    });

    const staleIds = allResults.matches
      .filter((m) => (m.metadata!.timestamp_ms as number) < cutoffMs)
      .map((m) => m.id);

    if (staleIds.length > 0) {
      await this.vectorize.deleteByIds(staleIds);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd trend-skill && npx vitest run tests/storage/vectorize.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add trend-skill/src/storage/vectorize.ts trend-skill/tests/storage/vectorize.test.ts
git commit -m "feat(trend): add Vectorize store with semantic search and retention cleanup"
```

---

## Task 8: Auth — API Keys

**Files:**
- Create: `trend-skill/src/auth/keys.ts`
- Create: `trend-skill/tests/auth/keys.test.ts`

- [ ] **Step 1: Write the failing test**

Create `trend-skill/tests/auth/keys.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiKeyService } from "../../src/auth/keys";

const makeD1Mock = () => {
  const rows: any[] = [];
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => rows[0] ?? null),
        run: vi.fn().mockResolvedValue({}),
      }),
    }),
    _rows: rows,
  } as unknown as D1Database;
};

describe("ApiKeyService", () => {
  let db: D1Database;
  let service: ApiKeyService;

  beforeEach(() => {
    db = makeD1Mock();
    service = new ApiKeyService(db);
  });

  it("create generates sk_trend_ prefixed key", async () => {
    const result = await service.create("free", "test-owner");
    expect(result.key).toMatch(/^sk_trend_[a-f0-9]{32}$/);
    expect(result.tier).toBe("free");
    expect(db.prepare).toHaveBeenCalled();
  });

  it("get returns null for unknown key", async () => {
    const result = await service.get("sk_trend_nonexistent");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd trend-skill && npx vitest run tests/auth/keys.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write implementation**

Create `trend-skill/src/auth/keys.ts`:

```typescript
import type { Tier } from "../types";

export interface ApiKey {
  key: string;
  tier: Tier;
  owner_name: string | null;
  created_at: string;
  expires_at: string | null;
  is_active: number;
}

export class ApiKeyService {
  constructor(private db: D1Database) {}

  async create(tier: Tier = "free", ownerName?: string): Promise<ApiKey> {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const key = `sk_trend_${hex}`;
    const now = new Date().toISOString();

    await this.db
      .prepare("INSERT INTO api_keys (key, tier, owner_name, created_at) VALUES (?, ?, ?, ?)")
      .bind(key, tier, ownerName ?? null, now)
      .run();

    return { key, tier, owner_name: ownerName ?? null, created_at: now, expires_at: null, is_active: 1 };
  }

  async get(key: string): Promise<ApiKey | null> {
    return this.db
      .prepare("SELECT * FROM api_keys WHERE key = ?")
      .bind(key)
      .first<ApiKey>();
  }

  async updateTier(key: string, tier: Tier): Promise<void> {
    await this.db
      .prepare("UPDATE api_keys SET tier = ? WHERE key = ?")
      .bind(tier, key)
      .run();
  }

  async deactivate(key: string): Promise<void> {
    await this.db
      .prepare("UPDATE api_keys SET is_active = 0 WHERE key = ?")
      .bind(key)
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM api_keys WHERE key = ?")
      .bind(key)
      .run();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd trend-skill && npx vitest run tests/auth/keys.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add trend-skill/src/auth/keys.ts trend-skill/tests/auth/keys.test.ts
git commit -m "feat(trend): add API key service with D1 storage"
```

---

## Task 9: Auth — Middleware + Rate Limiter

**Files:**
- Create: `trend-skill/src/auth/middleware.ts`
- Create: `trend-skill/src/auth/rate-limit.ts`
- Create: `trend-skill/tests/auth/middleware.test.ts`
- Create: `trend-skill/tests/auth/rate-limit.test.ts`

- [ ] **Step 1: Write the middleware test**

Create `trend-skill/tests/auth/middleware.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveAuth } from "../../src/auth/middleware";

const makeD1Mock = (row: any = null) => ({
  prepare: vi.fn().mockReturnValue({
    bind: vi.fn().mockReturnValue({
      first: vi.fn().mockResolvedValue(row),
    }),
  }),
}) as unknown as D1Database;

describe("resolveAuth", () => {
  it("returns anonymous when no API key provided", async () => {
    const result = await resolveAuth(undefined, makeD1Mock());
    expect(result).toEqual({ tier: "anonymous", identifier: "anonymous" });
  });

  it("returns error for invalid key", async () => {
    const result = await resolveAuth("sk_trend_bad", makeD1Mock(null));
    expect(result).toEqual({ error: "Invalid API key", status: 401 });
  });

  it("returns error for deactivated key", async () => {
    const db = makeD1Mock({ key: "sk_trend_x", tier: "free", is_active: 0, expires_at: null });
    const result = await resolveAuth("sk_trend_x", db);
    expect(result).toEqual({ error: "API key deactivated", status: 403 });
  });

  it("returns error for expired key", async () => {
    const db = makeD1Mock({ key: "sk_trend_x", tier: "free", is_active: 1, expires_at: "2020-01-01T00:00:00Z" });
    const result = await resolveAuth("sk_trend_x", db);
    expect(result).toEqual({ error: "API key expired", status: 403 });
  });

  it("returns tier and identifier for valid key", async () => {
    const db = makeD1Mock({ key: "sk_trend_abc", tier: "premium", is_active: 1, expires_at: null });
    const result = await resolveAuth("sk_trend_abc", db);
    expect(result).toEqual({ tier: "premium", identifier: "sk_trend_abc" });
  });
});
```

- [ ] **Step 2: Write the rate limiter test**

Create `trend-skill/tests/auth/rate-limit.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RateLimiter } from "../../src/auth/rate-limit";

const makeKvMock = () => {
  const store = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => { store.set(key, value); return Promise.resolve(); },
  } as unknown as KVNamespace;
};

describe("RateLimiter", () => {
  let kv: KVNamespace;
  let limiter: RateLimiter;

  beforeEach(() => {
    kv = makeKvMock();
    limiter = new RateLimiter(kv);
  });

  it("allows first request", async () => {
    const result = await limiter.check("user1", "anonymous");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
  });

  it("blocks after limit exceeded", async () => {
    for (let i = 0; i < 10; i++) {
      await limiter.check("user2", "anonymous");
    }
    const result = await limiter.check("user2", "anonymous");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("uses tier-specific limits", async () => {
    for (let i = 0; i < 10; i++) {
      await limiter.check("user3", "free");
    }
    const result = await limiter.check("user3", "free");
    expect(result.allowed).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd trend-skill && npx vitest run tests/auth/`
Expected: FAIL — cannot find modules.

- [ ] **Step 4: Write middleware implementation**

Create `trend-skill/src/auth/middleware.ts`:

```typescript
import type { AuthResult, AuthError, Tier } from "../types";

export async function resolveAuth(
  apiKey: string | undefined,
  db: D1Database
): Promise<AuthResult | AuthError> {
  if (!apiKey) {
    return { tier: "anonymous", identifier: "anonymous" };
  }

  const row = await db
    .prepare("SELECT key, tier, is_active, expires_at FROM api_keys WHERE key = ?")
    .bind(apiKey)
    .first<{ key: string; tier: Tier; is_active: number; expires_at: string | null }>();

  if (!row) {
    return { error: "Invalid API key", status: 401 };
  }

  if (!row.is_active) {
    return { error: "API key deactivated", status: 403 };
  }

  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return { error: "API key expired", status: 403 };
  }

  return { tier: row.tier, identifier: row.key };
}
```

- [ ] **Step 5: Write rate limiter implementation**

Create `trend-skill/src/auth/rate-limit.ts`:

```typescript
import type { Tier, RateLimitResult } from "../types";
import { TIER_RATE_LIMITS } from "../types";

export class RateLimiter {
  constructor(private kv: KVNamespace) {}

  async check(identifier: string, tier: Tier): Promise<RateLimitResult> {
    const limit = TIER_RATE_LIMITS[tier];
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    const key = `ratelimit:${identifier}:${hourBucket}`;

    const current = parseInt((await this.kv.get(key)) ?? "0", 10);

    if (current >= limit) {
      const secondsIntoHour = Math.floor((Date.now() % 3_600_000) / 1000);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: 3600 - secondsIntoHour,
      };
    }

    await this.kv.put(key, String(current + 1), { expirationTtl: 3600 });
    return {
      allowed: true,
      remaining: limit - current - 1,
    };
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd trend-skill && npx vitest run tests/auth/`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add trend-skill/src/auth/middleware.ts trend-skill/src/auth/rate-limit.ts trend-skill/tests/auth/middleware.test.ts trend-skill/tests/auth/rate-limit.test.ts
git commit -m "feat(trend): add auth middleware and KV rate limiter"
```

---

## Task 10: Webhook + Digest

**Files:**
- Create: `trend-skill/src/push/webhook.ts`
- Create: `trend-skill/src/push/digest.ts`
- Create: `trend-skill/tests/push/webhook.test.ts`
- Create: `trend-skill/tests/push/digest.test.ts`

- [ ] **Step 1: Write the webhook test**

Create `trend-skill/tests/push/webhook.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendWebhook, signPayload } from "../../src/push/webhook";

describe("signPayload", () => {
  it("produces consistent HMAC-SHA256 hex digest", async () => {
    const sig1 = await signPayload('{"test":true}', "secret123");
    const sig2 = await signPayload('{"test":true}', "secret123");
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("different secrets produce different signatures", async () => {
    const sig1 = await signPayload("same body", "secret-a");
    const sig2 = await signPayload("same body", "secret-b");
    expect(sig1).not.toBe(sig2);
  });
});

describe("sendWebhook", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("posts JSON payload with HMAC signature header", async () => {
    await sendWebhook("https://example.com/hook", "my-secret", { event: "test" });

    expect(fetchMock).toHaveBeenCalledWith("https://example.com/hook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      body: JSON.stringify({ event: "test" }),
    });
  });

  it("does nothing when URL is empty", async () => {
    await sendWebhook("", "secret", { event: "test" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Write the digest test**

Create `trend-skill/tests/push/digest.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { buildDailyDigest } from "../../src/push/digest";
import type { TrendItem, TrendSearchResult } from "../../src/types";
import type { TrendVectorStore } from "../../src/storage/vectorize";

function makeTrend(title: string, date: string, location = "global"): TrendItem {
  return {
    id: `${date}:tw:gl:abc12345`,
    platform: "twitter",
    location,
    language: "en",
    title,
    score: 80,
    metrics: {},
    categories: [],
    timestamp: `${date}T00:00:00Z`,
  };
}

const makeStoreMock = (searchResults: TrendSearchResult[]): TrendVectorStore => ({
  search: vi.fn().mockResolvedValue(searchResults),
  upsertTrends: vi.fn(),
  cleanupOld: vi.fn(),
  buildEmbeddingText: vi.fn(),
}) as unknown as TrendVectorStore;

describe("buildDailyDigest", () => {
  it("returns persistent topics that appear both days", async () => {
    const yesterday = [makeTrend("AI Revolution", "2026-04-27")];
    const todayMatch: TrendSearchResult = {
      item: makeTrend("AI Revolution", "2026-04-28"),
      similarity: 0.92,
    };

    const store = makeStoreMock([todayMatch]);
    const digest = await buildDailyDigest(store, yesterday, "2026-04-28");

    expect(digest.persistent_topics).toHaveLength(1);
    expect(digest.persistent_topics[0].title).toBe("AI Revolution");
    expect(digest.persistent_topics[0].days_trending).toBe(2);
  });

  it("excludes topics below similarity threshold", async () => {
    const yesterday = [makeTrend("Old Topic", "2026-04-27")];
    const weakMatch: TrendSearchResult = {
      item: makeTrend("Different Topic", "2026-04-28"),
      similarity: 0.60,
    };

    const store = makeStoreMock([weakMatch]);
    const digest = await buildDailyDigest(store, yesterday, "2026-04-28");

    expect(digest.persistent_topics).toHaveLength(0);
  });

  it("returns empty digest when no yesterday trends", async () => {
    const store = makeStoreMock([]);
    const digest = await buildDailyDigest(store, [], "2026-04-28");

    expect(digest.persistent_topics).toHaveLength(0);
    expect(digest.cross_platform_topics).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd trend-skill && npx vitest run tests/push/`
Expected: FAIL — cannot find modules.

- [ ] **Step 4: Write webhook implementation**

Create `trend-skill/src/push/webhook.ts`:

```typescript
export async function signPayload(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sendWebhook(url: string, secret: string, payload: unknown): Promise<void> {
  if (!url) return;

  const body = JSON.stringify(payload);
  const signature = await signPayload(body, secret);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Signature": signature,
    },
    body,
  });

  if (!response.ok) {
    console.error(`Webhook delivery failed: ${response.status} ${response.statusText}`);
  }
}
```

- [ ] **Step 5: Write digest implementation**

Create `trend-skill/src/push/digest.ts`:

```typescript
import type { TrendItem, PersistentTopic, CrossPlatformTopic } from "../types";
import type { TrendVectorStore } from "../storage/vectorize";

const SIMILARITY_THRESHOLD = 0.85;

export async function buildDailyDigest(
  store: TrendVectorStore,
  yesterdayTrends: TrendItem[],
  todayDate: string
): Promise<{ persistent_topics: PersistentTopic[]; cross_platform_topics: CrossPlatformTopic[] }> {
  const persistent: PersistentTopic[] = [];

  for (const trend of yesterdayTrends) {
    const matches = await store.search(trend.title, 1, { date: todayDate });

    if (matches.length > 0 && matches[0].similarity >= SIMILARITY_THRESHOLD) {
      persistent.push({
        title: matches[0].item.title,
        platform: matches[0].item.platform,
        location: matches[0].item.location,
        days_trending: 2,
        current_score: matches[0].item.score,
        url: matches[0].item.url,
      });
    }
  }

  return {
    persistent_topics: persistent,
    cross_platform_topics: [],
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd trend-skill && npx vitest run tests/push/`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add trend-skill/src/push/webhook.ts trend-skill/src/push/digest.ts trend-skill/tests/push/webhook.test.ts trend-skill/tests/push/digest.test.ts
git commit -m "feat(trend): add webhook delivery and daily digest builder"
```

---

## Task 11: HTTP API Routes

**Files:**
- Create: `trend-skill/src/api/trends.ts`
- Create: `trend-skill/src/api/admin.ts`
- Create: `trend-skill/tests/api/trends.test.ts`
- Create: `trend-skill/tests/api/admin.test.ts`

- [ ] **Step 1: Write the trends API test**

Create `trend-skill/tests/api/trends.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createTrendsRouter } from "../../src/api/trends";
import type { TrendItem, Env } from "../../src/types";

function makeTrend(title: string, location = "global", language = "en"): TrendItem {
  return {
    id: `2026-04-28:tw:gl:test`,
    platform: "twitter",
    location,
    language,
    title,
    score: 80,
    metrics: {},
    categories: [],
    timestamp: "2026-04-28T00:00:00Z",
  };
}

const makeApp = (kvData: TrendItem[] | null = null) => {
  const app = new Hono<{ Bindings: Env }>();

  const mockKv = {
    get: vi.fn().mockResolvedValue(kvData ? JSON.stringify(kvData) : null),
  };

  app.use("*", async (c, next) => {
    (c.env as any) = { TREND_KV: mockKv };
    c.set("tier" as never, "anonymous");
    await next();
  });

  app.route("/api", createTrendsRouter());
  return app;
};

describe("GET /api/trends", () => {
  it("returns latest trends from KV", async () => {
    const trends = [makeTrend("AI"), makeTrend("Climate")];
    const app = makeApp(trends);
    const res = await app.request("/api/trends");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(2);
  });

  it("filters by location", async () => {
    const trends = [makeTrend("AI", "global"), makeTrend("Topic", "china", "zh")];
    const app = makeApp(trends);
    const res = await app.request("/api/trends?location=china");
    const data = await res.json();
    expect(data.items).toHaveLength(1);
    expect(data.items[0].location).toBe("china");
  });

  it("returns empty array when KV is empty", async () => {
    const app = makeApp(null);
    const res = await app.request("/api/trends");
    const data = await res.json();
    expect(data.items).toEqual([]);
  });
});
```

- [ ] **Step 2: Write the admin API test**

Create `trend-skill/tests/api/admin.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createAdminRouter } from "../../src/api/admin";
import type { Env } from "../../src/types";

const makeApp = (adminSecret = "test-secret") => {
  const mockDb = {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run: vi.fn().mockResolvedValue({}),
        first: vi.fn().mockResolvedValue({ key: "sk_trend_abc", tier: "free", is_active: 1 }),
      }),
    }),
  };

  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    (c.env as any) = { TREND_DB: mockDb, ADMIN_SECRET: adminSecret };
    await next();
  });
  app.route("/admin", createAdminRouter());
  return app;
};

describe("Admin API", () => {
  it("rejects requests without valid Bearer token", async () => {
    const app = makeApp();
    const res = await app.request("/admin/keys", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("creates a key with valid auth", async () => {
    const app = makeApp();
    const res = await app.request("/admin/keys", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tier: "free", owner_name: "test" }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.key).toMatch(/^sk_trend_/);
  });

  it("gets key info", async () => {
    const app = makeApp();
    const res = await app.request("/admin/keys/sk_trend_abc", {
      headers: { Authorization: "Bearer test-secret" },
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd trend-skill && npx vitest run tests/api/`
Expected: FAIL — cannot find modules.

- [ ] **Step 4: Write trends router**

Create `trend-skill/src/api/trends.ts`:

```typescript
import { Hono } from "hono";
import type { Env, TrendItem } from "../types";

export function createTrendsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/trends", async (c) => {
    const location = c.req.query("location");
    const language = c.req.query("language");
    const platform = c.req.query("platform");
    const limit = parseInt(c.req.query("limit") ?? "50", 10);

    const raw = await c.env.TREND_KV.get("trends:latest");
    let items: TrendItem[] = raw ? JSON.parse(raw) : [];

    if (location) items = items.filter((t) => t.location === location);
    if (language) items = items.filter((t) => t.language === language);
    if (platform) items = items.filter((t) => t.platform === platform);

    return c.json({ items: items.slice(0, limit) });
  });

  return router;
}
```

- [ ] **Step 5: Write admin router**

Create `trend-skill/src/api/admin.ts`:

```typescript
import { Hono } from "hono";
import type { Env } from "../types";
import { ApiKeyService } from "../auth/keys";

export function createAdminRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.use("*", async (c, next) => {
    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${c.env.ADMIN_SECRET}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  router.post("/keys", async (c) => {
    const body = await c.req.json<{ tier?: string; owner_name?: string }>();
    const service = new ApiKeyService(c.env.TREND_DB);
    const key = await service.create(
      (body.tier as "free" | "premium") ?? "free",
      body.owner_name
    );
    return c.json(key, 201);
  });

  router.get("/keys/:key", async (c) => {
    const service = new ApiKeyService(c.env.TREND_DB);
    const key = await service.get(c.req.param("key"));
    if (!key) return c.json({ error: "Not found" }, 404);
    return c.json(key);
  });

  router.patch("/keys/:key", async (c) => {
    const body = await c.req.json<{ tier?: string; is_active?: boolean }>();
    const service = new ApiKeyService(c.env.TREND_DB);

    if (body.tier) await service.updateTier(c.req.param("key"), body.tier as "free" | "premium");
    if (body.is_active === false) await service.deactivate(c.req.param("key"));

    const updated = await service.get(c.req.param("key"));
    return c.json(updated);
  });

  router.delete("/keys/:key", async (c) => {
    const service = new ApiKeyService(c.env.TREND_DB);
    await service.delete(c.req.param("key"));
    return c.json({ deleted: true });
  });

  return router;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd trend-skill && npx vitest run tests/api/`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add trend-skill/src/api/trends.ts trend-skill/src/api/admin.ts trend-skill/tests/api/trends.test.ts trend-skill/tests/api/admin.test.ts
git commit -m "feat(trend): add trends and admin HTTP API routes"
```

---

## Task 12: MCP Server + Tools

**Files:**
- Create: `trend-skill/src/mcp/server.ts`
- Create: `trend-skill/src/mcp/tools.ts`
- Create: `trend-skill/tests/mcp/tools.test.ts`

- [ ] **Step 1: Write the MCP tools test**

Create `trend-skill/tests/mcp/tools.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { handleTrendingNow, handleSearchTrends, handleGetDailyDigest } from "../../src/mcp/tools";
import type { TrendItem, Env } from "../../src/types";

function makeTrend(title: string, location = "global"): TrendItem {
  return {
    id: `2026-04-28:tw:gl:test`,
    platform: "twitter",
    location,
    language: "en",
    title,
    score: 80,
    metrics: {},
    categories: [],
    timestamp: "2026-04-28T00:00:00Z",
  };
}

const makeEnv = (kvData: TrendItem[] | null = null) =>
  ({
    TREND_KV: {
      get: vi.fn().mockResolvedValue(kvData ? JSON.stringify(kvData) : null),
    },
    TREND_VECTORIZE: {
      query: vi.fn().mockResolvedValue({ matches: [] }),
    },
    AI: {
      run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2]] }),
    },
  }) as unknown as Env;

describe("handleTrendingNow", () => {
  it("returns top trends from KV", async () => {
    const trends = [makeTrend("AI"), makeTrend("Climate")];
    const env = makeEnv(trends);
    const result = await handleTrendingNow(env, { limit: 10 });
    expect(result.items).toHaveLength(2);
  });

  it("filters by location", async () => {
    const trends = [makeTrend("AI", "global"), makeTrend("Topic", "china")];
    const env = makeEnv(trends);
    const result = await handleTrendingNow(env, { location: "china", limit: 10 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].location).toBe("china");
  });
});

describe("handleSearchTrends", () => {
  it("calls vectorize search with filters", async () => {
    const item = makeTrend("AI");
    const env = makeEnv();
    (env.TREND_VECTORIZE as any).query.mockResolvedValue({
      matches: [{ id: item.id, score: 0.95, metadata: { item: JSON.stringify(item) } }],
    });

    const result = await handleSearchTrends(env, { query: "artificial intelligence", limit: 10 });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].similarity).toBe(0.95);
  });
});

describe("handleGetDailyDigest", () => {
  it("returns digest structure", async () => {
    const env = makeEnv([makeTrend("AI")]);
    const result = await handleGetDailyDigest(env);
    expect(result).toHaveProperty("persistent_topics");
    expect(result).toHaveProperty("cross_platform_topics");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd trend-skill && npx vitest run tests/mcp/tools.test.ts`
Expected: FAIL — cannot find modules.

- [ ] **Step 3: Write MCP tool handlers**

Create `trend-skill/src/mcp/tools.ts`:

```typescript
import type { TrendItem, Env } from "../types";
import { TrendVectorStore } from "../storage/vectorize";
import { buildDailyDigest } from "../push/digest";

export async function handleTrendingNow(
  env: Env,
  params: { location?: string; language?: string; limit?: number }
): Promise<{ items: TrendItem[] }> {
  const raw = await env.TREND_KV.get("trends:latest");
  let items: TrendItem[] = raw ? JSON.parse(raw) : [];

  if (params.location) items = items.filter((t) => t.location === params.location);
  if (params.language) items = items.filter((t) => t.language === params.language);

  return { items: items.slice(0, params.limit ?? 20) };
}

export async function handleSearchTrends(
  env: Env,
  params: { query: string; platform?: string; location?: string; language?: string; limit?: number }
): Promise<{ results: { item: TrendItem; similarity: number }[] }> {
  const store = new TrendVectorStore(env.TREND_VECTORIZE, env.AI);
  const filter: Record<string, string> = {};
  if (params.platform) filter.platform = params.platform;
  if (params.location) filter.location = params.location;
  if (params.language) filter.language = params.language;

  const results = await store.search(
    params.query,
    params.limit ?? 20,
    Object.keys(filter).length > 0 ? filter : undefined
  );

  return { results };
}

export async function handleQueryTrends(
  env: Env,
  params: { platform?: string; location?: string; language?: string; date?: string; limit?: number }
): Promise<{ items: TrendItem[] }> {
  const store = new TrendVectorStore(env.TREND_VECTORIZE, env.AI);
  const filter: Record<string, string> = {};
  if (params.platform) filter.platform = params.platform;
  if (params.location) filter.location = params.location;
  if (params.language) filter.language = params.language;
  if (params.date) filter.date = params.date;

  const results = await store.search("", params.limit ?? 20, Object.keys(filter).length > 0 ? filter : undefined);
  return { items: results.map((r) => r.item) };
}

export async function handleGetTrendDetail(
  env: Env,
  params: { id: string }
): Promise<TrendItem | null> {
  const store = new TrendVectorStore(env.TREND_VECTORIZE, env.AI);
  const results = await store.search(params.id, 1);
  return results.length > 0 ? results[0].item : null;
}

export async function handleGetDailyDigest(
  env: Env
): Promise<{ persistent_topics: any[]; cross_platform_topics: any[] }> {
  const store = new TrendVectorStore(env.TREND_VECTORIZE, env.AI);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const yesterdayResults = await store.search("", 100, { date: yesterday });
  const yesterdayItems = yesterdayResults.map((r) => r.item);

  return buildDailyDigest(store, yesterdayItems, today);
}
```

- [ ] **Step 4: Write MCP server factory**

Create `trend-skill/src/mcp/server.ts`:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env, Tier } from "../types";
import {
  handleTrendingNow,
  handleSearchTrends,
  handleQueryTrends,
  handleGetTrendDetail,
  handleGetDailyDigest,
} from "./tools";

export function createMcpServer(env: Env, tier: Tier): McpServer {
  const server = new McpServer({
    name: "trend-skill",
    version: "0.1.0",
  });

  server.tool("list_platforms", "List active trend platforms", {}, async () => ({
    content: [{ type: "text", text: JSON.stringify({ platforms: ["twitter"] }) }],
  }));

  server.tool(
    "trending_now",
    "Get top trending topics right now",
    {
      location: z.string().optional().describe("Filter by location (global, china)"),
      language: z.string().optional().describe("Filter by language (en, zh)"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async (params) => {
      const result = await handleTrendingNow(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "search_trends",
    "Semantic search for trends (requires auth)",
    {
      query: z.string().describe("Search query"),
      platform: z.string().optional(),
      location: z.string().optional(),
      language: z.string().optional(),
      limit: z.number().optional(),
    },
    async (params) => {
      if (tier === "anonymous") {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Authentication required" }) }] };
      }
      const result = await handleSearchTrends(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "query_trends",
    "Query trends with filters (requires auth)",
    {
      platform: z.string().optional(),
      location: z.string().optional(),
      language: z.string().optional(),
      date: z.string().optional().describe("Filter by date (YYYY-MM-DD)"),
      limit: z.number().optional(),
    },
    async (params) => {
      if (tier === "anonymous") {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Authentication required" }) }] };
      }
      const result = await handleQueryTrends(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "get_trend_detail",
    "Get details for a specific trend by ID (requires auth)",
    { id: z.string().describe("Trend ID") },
    async (params) => {
      if (tier === "anonymous") {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Authentication required" }) }] };
      }
      const result = await handleGetTrendDetail(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result ?? { error: "Not found" }) }] };
    }
  );

  server.tool("get_daily_digest", "Get today's trend digest (persistent and cross-platform topics)", {}, async () => {
    const result = await handleGetDailyDigest(env);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  return server;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd trend-skill && npx vitest run tests/mcp/tools.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add trend-skill/src/mcp/server.ts trend-skill/src/mcp/tools.ts trend-skill/tests/mcp/tools.test.ts
git commit -m "feat(trend): add MCP server with 6 tools"
```

---

## Task 13: Main Entry Point — Hono App + Cron Handler

**Files:**
- Create: `trend-skill/src/index.ts`

- [ ] **Step 1: Write the main entry point**

Create `trend-skill/src/index.ts`:

```typescript
import { Hono } from "hono";
import type { Env } from "./types";
import { createTrendsRouter } from "./api/trends";
import { createAdminRouter } from "./api/admin";
import { resolveAuth } from "./auth/middleware";
import { RateLimiter } from "./auth/rate-limit";
import { Aggregator } from "./core/aggregator";
import { TwitterTrendSource } from "./sources/twitter";
import { TrendCache } from "./storage/cache";
import { TrendVectorStore } from "./storage/vectorize";
import { buildDailyDigest } from "./push/digest";
import { sendWebhook } from "./push/webhook";
import { createMcpServer } from "./mcp/server";
import type { DigestPayload } from "./types";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

app.use("/api/*", async (c, next) => {
  const apiKey = c.req.header("X-API-Key");
  const authResult = await resolveAuth(apiKey, c.env.TREND_DB);

  if ("error" in authResult) {
    return c.json({ error: authResult.error }, authResult.status as 401 | 403);
  }

  const identifier = authResult.identifier ?? c.req.header("CF-Connecting-IP") ?? "unknown";
  const limiter = new RateLimiter(c.env.TREND_KV);
  const rateResult = await limiter.check(identifier, authResult.tier);

  if (!rateResult.allowed) {
    return c.json(
      { error: "Rate limit exceeded", retryAfterSeconds: rateResult.retryAfterSeconds },
      429
    );
  }

  c.set("tier" as never, authResult.tier);
  await next();
});

app.route("/api", createTrendsRouter());
app.route("/admin", createAdminRouter());

app.all("/mcp", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  const authResult = await resolveAuth(apiKey, c.env.TREND_DB);

  let tier: "anonymous" | "free" | "premium" = "anonymous";
  if (!("error" in authResult)) {
    tier = authResult.tier;
  }

  const server = createMcpServer(c.env, tier);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

async function handleCron(env: Env): Promise<void> {
  const source = new TwitterTrendSource(env.TWITTER_BEARER_TOKEN);
  const aggregator = new Aggregator([source]);
  const cache = new TrendCache(env.TREND_KV);
  const vectorStore = new TrendVectorStore(env.TREND_VECTORIZE, env.AI);

  const { items } = await aggregator.fetchAll();

  // 1. KV: overwrite latest snapshots
  await cache.setLatest(items);

  const byKey = new Map<string, typeof items>();
  for (const item of items) {
    const key = `${item.platform}:${item.location}`;
    const list = byKey.get(key) ?? [];
    list.push(item);
    byKey.set(key, list);
  }
  for (const [key, platformItems] of byKey) {
    const [platform, location] = key.split(":");
    await cache.setPlatformLatest(platform, location, platformItems);
  }

  // 2. Vectorize: upsert trends
  await vectorStore.upsertTrends(items);

  // 3. Vectorize: cleanup expired data
  const retentionDays = parseInt(env.TREND_RETENTION_DAYS || "30", 10);
  await vectorStore.cleanupOld(retentionDays);

  // 4. Push: daily digest webhook
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const yesterdayResults = await vectorStore.search("", 100, { date: yesterday });
  const digest = await buildDailyDigest(vectorStore, yesterdayResults.map((r) => r.item), today);

  const payload: DigestPayload = {
    event: "trend.daily_digest",
    timestamp: new Date().toISOString(),
    data: digest,
  };

  await sendWebhook(env.WEBHOOK_URL, env.WEBHOOK_SECRET, payload);
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleCron(env));
  },
};
```

- [ ] **Step 2: Verify typecheck compiles**

Run: `cd trend-skill && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run full test suite**

Run: `cd trend-skill && npx vitest run`
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add trend-skill/src/index.ts
git commit -m "feat(trend): add main entry point with Hono app, cron handler, and MCP endpoint"
```

---

## Task 14: Skill Definition Files

**Files:**
- Create: `trend-skill/skill/SKILL.md`
- Create: `trend-skill/skill/manifest.json`

- [ ] **Step 1: Create SKILL.md**

Create `trend-skill/skill/SKILL.md`:

```markdown
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
```

- [ ] **Step 2: Create manifest.json**

Create `trend-skill/skill/manifest.json`:

```json
{
  "name": "trend",
  "version": "0.1.0",
  "description": "Aggregates trending topics from social media platforms with semantic search and daily digest.",
  "author": "uniscrm",
  "commands": [
    {
      "name": "trend",
      "description": "Query trending topics across platforms",
      "parameters": [
        { "name": "query", "type": "string", "description": "Semantic search query", "required": false },
        { "name": "platform", "type": "string", "description": "Filter by platform", "required": false },
        { "name": "location", "type": "string", "description": "Filter by location (global, china)", "required": false, "default": "global" },
        { "name": "language", "type": "string", "description": "Filter by language (en, zh)", "required": false, "default": "en" },
        { "name": "limit", "type": "number", "description": "Max results", "required": false, "default": 20 }
      ]
    }
  ],
  "pricing": {
    "tiers": [
      {
        "name": "free",
        "rate_limit": "30 requests/hour",
        "features": ["Current trends", "Semantic search"]
      },
      {
        "name": "premium",
        "rate_limit": "300 requests/hour",
        "features": ["Current trends", "Semantic search", "Historical queries", "All filters"]
      }
    ]
  },
  "integration": {
    "type": "mcp",
    "auth": {
      "type": "api_key",
      "header": "X-API-Key"
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add trend-skill/skill/SKILL.md trend-skill/skill/manifest.json
git commit -m "feat(trend): add skill definition and ClawHub manifest"
```

---

## Task 15: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `cd trend-skill && npx vitest run`
Expected: all tests PASS (should be ~25+ tests across 12 test files).

- [ ] **Step 2: Typecheck**

Run: `cd trend-skill && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Verify project structure is complete**

Run: `find trend-skill/src -name "*.ts" | sort`
Expected output:
```
trend-skill/src/api/admin.ts
trend-skill/src/api/trends.ts
trend-skill/src/auth/keys.ts
trend-skill/src/auth/middleware.ts
trend-skill/src/auth/rate-limit.ts
trend-skill/src/core/aggregator.ts
trend-skill/src/core/normalizer.ts
trend-skill/src/index.ts
trend-skill/src/mcp/server.ts
trend-skill/src/mcp/tools.ts
trend-skill/src/push/digest.ts
trend-skill/src/push/webhook.ts
trend-skill/src/sources/interface.ts
trend-skill/src/sources/twitter.ts
trend-skill/src/storage/cache.ts
trend-skill/src/storage/vectorize.ts
trend-skill/src/types.ts
```

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A trend-skill/
git commit -m "feat(trend): complete trend skill implementation"
```
