# Recommendation Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reverse recommendation direction: take top 10 trends, find best-matching content and commerce product for each, rank by triangle similarity, display in a 3-column table.

**Architecture:** RecommendService rewritten to be trend-driven. Reads trends from KV, queries Vectorize for matching content and products per trend, computes pairwise cosine similarities, applies triangle ranking (mean vs median decides 2-col or 3-col grouping). Frontend becomes a fixed 3-column table.

**Tech Stack:** Hono, Cloudflare Vectorize/KV/D1, React, TypeScript

**Spec:** `docs/superpowers/specs/2026-04-30-recommendation-redesign.md`

---

### Task 1: Create Vectorize metadata index for `user_id`

Filtering by `user_id` in Vectorize queries requires a metadata index. The `type` and `location` indexes already exist.

- [ ] **Step 1: Create the metadata index**

```bash
cd trend-skill && npx wrangler vectorize create-metadata-index trend-embeddings-dev --property-name user_id --type string
```

Expected: `Successfully enqueued metadata index creation request`

- [ ] **Step 2: Verify the index was created**

```bash
npx wrangler vectorize list-metadata-index trend-embeddings-dev
```

Expected: Table showing `type` (String), `location` (String), `user_id` (String)

---

### Task 2: Update types — replace ContentMatch/TrendMatch with RecommendationGroup

**Files:**
- Modify: `web/worker/types.ts`

- [ ] **Step 1: Replace types**

Replace the `ContentMatch` and `TrendMatch` interfaces in `web/worker/types.ts` with:

```typescript
export interface RecommendationGroup {
  trend?: { id: string; title: string; platform: string; score: number; similarity: number };
  content?: { id: string; title: string; similarity: number };
  product?: { id: string; title: string; similarity: number };
  sort_score: number;
}
```

Remove the old `ContentMatch` and `TrendMatch` interfaces entirely (lines 19-31).

- [ ] **Step 2: Commit**

```bash
git add web/worker/types.ts
git commit -m "refactor(web): replace ContentMatch/TrendMatch with RecommendationGroup"
```

---

### Task 3: Rewrite RecommendService

**Files:**
- Modify: `web/worker/services/recommend.ts`
- Modify: `web/tests/services/recommend.test.ts`

- [ ] **Step 1: Write failing tests for new recommend service**

Replace `web/tests/services/recommend.test.ts` entirely:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RecommendService, cosineSimilarity } from "../../worker/services/recommend";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns ~0.5 for partially similar vectors", () => {
    const s = cosineSimilarity([1, 1, 0], [1, 0, 0]);
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThan(1);
  });
});

describe("RecommendService", () => {
  let db: any;
  let vectorize: any;
  let kv: any;
  let service: RecommendService;

  beforeEach(() => {
    db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: [] }),
        }),
      }),
    };
    vectorize = {
      getByIds: vi.fn().mockResolvedValue([]),
      query: vi.fn().mockResolvedValue({ matches: [] }),
    };
    kv = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
    };
    service = new RecommendService(db, vectorize, kv);
  });

  describe("computeForUser", () => {
    it("queries content and product for each trend, applies triangle ranking", async () => {
      const trendsJson = JSON.stringify([
        { id: "t1", title: "AI Trend", platform: "twitter", location: "global", score: 100 },
        { id: "t2", title: "Web Dev", platform: "twitter", location: "global", score: 90 },
      ]);
      kv.get.mockImplementation((key: string) => {
        if (key === "trends:latest") return trendsJson;
        return null;
      });

      vectorize.getByIds.mockResolvedValue([
        { id: "t1", values: [1, 0, 0] },
        { id: "t2", values: [0, 1, 0] },
      ]);

      let queryCount = 0;
      vectorize.query.mockImplementation(() => {
        queryCount++;
        if (queryCount === 1) {
          return { matches: [{ id: "c1", score: 0.9, metadata: { title: "Content A" } }] };
        }
        if (queryCount === 2) {
          return { matches: [{ id: "p1", score: 0.8, metadata: { title: "Product A" } }] };
        }
        if (queryCount === 3) {
          return { matches: [{ id: "c2", score: 0.7, metadata: { title: "Content B" } }] };
        }
        return { matches: [{ id: "p2", score: 0.6, metadata: { title: "Product B" } }] };
      });

      vectorize.getByIds
        .mockResolvedValueOnce([{ id: "t1", values: [1, 0, 0] }, { id: "t2", values: [0, 1, 0] }])
        .mockResolvedValueOnce([{ id: "c1", values: [0.9, 0.1, 0] }])
        .mockResolvedValueOnce([{ id: "c2", values: [0.1, 0.9, 0] }]);

      await service.computeForUser("u1", "global");

      expect(kv.put).toHaveBeenCalledWith(
        "recommendations:u1",
        expect.any(String)
      );
      const cached = JSON.parse(kv.put.mock.calls[0][1]);
      expect(cached.length).toBeGreaterThan(0);
      expect(cached[0]).toHaveProperty("sort_score");
    });

    it("skips when no trends in KV", async () => {
      await service.computeForUser("u1", "global");
      expect(vectorize.query).not.toHaveBeenCalled();
    });
  });

  describe("getForUser", () => {
    it("returns cached recommendations", async () => {
      kv.get.mockResolvedValue(
        JSON.stringify([
          { trend: { id: "t1", title: "T", platform: "tw", score: 100, similarity: 0.9 }, content: { id: "c1", title: "C", similarity: 0.8 }, sort_score: 0.85 },
        ])
      );

      const results = await service.getForUser("u1");
      expect(results).toHaveLength(1);
      expect(results[0].sort_score).toBe(0.85);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd web && npx vitest run tests/services/recommend.test.ts
```

Expected: FAIL — `cosineSimilarity` not exported, type mismatches

- [ ] **Step 3: Rewrite recommend.ts**

Replace `web/worker/services/recommend.ts` entirely:

```typescript
import type { RecommendationGroup } from "../types";

interface TrendItem {
  id: string;
  title: string;
  platform: string;
  location: string;
  score: number;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function triangleRank(
  s_tc: number,
  s_tp: number,
  s_cp: number,
  trend: RecommendationGroup["trend"],
  content: RecommendationGroup["content"],
  product: RecommendationGroup["product"]
): RecommendationGroup {
  const scores = [s_tc, s_tp, s_cp].sort((a, b) => a - b);
  const median = scores[1];
  const mean = (s_tc + s_tp + s_cp) / 3;

  if (mean >= median) {
    return { trend, content, product, sort_score: mean };
  }

  const pairs: { score: number; group: RecommendationGroup }[] = [
    { score: s_tc, group: { trend, content, sort_score: s_tc } },
    { score: s_tp, group: { trend, product, sort_score: s_tp } },
    { score: s_cp, group: { content, product, sort_score: s_cp } },
  ];
  const best = pairs.sort((a, b) => b.score - a.score)[0];
  return best.group;
}

export class RecommendService {
  constructor(
    private db: D1Database,
    private vectorize: VectorizeIndex,
    private kv: KVNamespace
  ) {}

  async computeForUser(userId: string, location: string = "global"): Promise<void> {
    const raw = await this.kv.get("trends:latest");
    if (!raw) return;

    const allTrends = JSON.parse(raw) as TrendItem[];
    const trends = allTrends
      .filter((t) => t.location === location)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    if (trends.length === 0) return;

    const trendIds = trends.map((t) => t.id);
    const trendVectors = await this.batchGetByIds(trendIds);
    const trendVecMap = new Map(trendVectors.map((v) => [v.id, v.values]));

    const groups: RecommendationGroup[] = [];

    for (const trend of trends) {
      const trendVec = trendVecMap.get(trend.id);
      if (!trendVec) continue;

      const [contentResult, productResult] = await Promise.all([
        this.vectorize.query(trendVec, {
          filter: { type: "content", user_id: userId },
          topK: 1,
          returnMetadata: "all",
        }),
        this.vectorize.query(trendVec, {
          filter: { type: "product", user_id: userId },
          topK: 1,
          returnMetadata: "all",
        }),
      ]);

      const contentMatch = contentResult.matches[0];
      const productMatch = productResult.matches[0];

      if (!contentMatch && !productMatch) continue;

      const trendRef: RecommendationGroup["trend"] = {
        id: trend.id,
        title: trend.title,
        platform: trend.platform,
        score: trend.score,
        similarity: 1,
      };

      if (contentMatch && productMatch) {
        const s_tc = contentMatch.score;
        const s_tp = productMatch.score;

        const cpVecs = await this.batchGetByIds([contentMatch.id, productMatch.id]);
        const contentVec = cpVecs.find((v) => v.id === contentMatch.id)?.values;
        const productVec = cpVecs.find((v) => v.id === productMatch.id)?.values;
        const s_cp = contentVec && productVec ? cosineSimilarity(contentVec, productVec) : 0;

        const contentRef = { id: contentMatch.id, title: (contentMatch.metadata?.title as string) ?? "", similarity: s_tc };
        const productRef = { id: productMatch.id, title: (productMatch.metadata?.title as string) ?? "", similarity: s_tp };

        groups.push(triangleRank(s_tc, s_tp, s_cp, trendRef, contentRef, productRef));
      } else if (contentMatch) {
        groups.push({
          trend: trendRef,
          content: { id: contentMatch.id, title: (contentMatch.metadata?.title as string) ?? "", similarity: contentMatch.score },
          sort_score: contentMatch.score,
        });
      } else if (productMatch) {
        groups.push({
          trend: trendRef,
          product: { id: productMatch.id, title: (productMatch.metadata?.title as string) ?? "", similarity: productMatch.score },
          sort_score: productMatch.score,
        });
      }
    }

    groups.sort((a, b) => b.sort_score - a.sort_score);
    const top10 = groups.slice(0, 10);
    await this.kv.put(`recommendations:${userId}`, JSON.stringify(top10));
  }

  async getForUser(userId: string): Promise<RecommendationGroup[]> {
    const cached = await this.kv.get(`recommendations:${userId}`);
    if (!cached) return [];
    return JSON.parse(cached) as RecommendationGroup[];
  }

  private async batchGetByIds(ids: string[]): Promise<VectorizeVector[]> {
    const all: VectorizeVector[] = [];
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      const result = await this.vectorize.getByIds(batch);
      all.push(...result);
    }
    return all;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd web && npx vitest run tests/services/recommend.test.ts
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add web/worker/services/recommend.ts web/tests/services/recommend.test.ts
git commit -m "feat(web): rewrite RecommendService with trend-driven triangle ranking"
```

---

### Task 4: Update API routes and webhook

**Files:**
- Modify: `web/worker/api/recommendations.ts`
- Modify: `web/worker/api/webhook.ts`
- Modify: `web/worker/api/settings.ts`

- [ ] **Step 1: Update recommendations route**

Replace `web/worker/api/recommendations.ts`:

```typescript
import { Hono } from "hono";
import type { Env } from "../types";
import { RecommendService } from "../services/recommend";

export function createRecommendationsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/", async (c) => {
    const userId = c.get("userId" as never) as string;
    const service = new RecommendService(c.env.DB, c.env.VECTORIZE, c.env.KV);
    const recommendations = await service.getForUser(userId);
    return c.json({ recommendations });
  });

  return router;
}
```

Change: removed `.slice(0, 5)` — the service already returns top 10.

- [ ] **Step 2: Update webhook to pass user's preferred_location**

In `web/worker/api/webhook.ts`, the loop that calls `computeForUser` needs to read each user's `preferred_location`:

Replace lines 38-44:

```typescript
    const { results: users } = await c.env.DB
      .prepare("SELECT id, preferred_location FROM users")
      .all<{ id: string; preferred_location: string }>();

    for (const user of users) {
      try {
        await service.computeForUser(user.id, user.preferred_location ?? "global");
      } catch (e) {
        console.error(`Recommend failed for user ${user.id}:`, e instanceof Error ? e.message : e);
      }
    }
```

- [ ] **Step 3: Run all web tests**

```bash
cd web && npx vitest run
```

Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add web/worker/api/recommendations.ts web/worker/api/webhook.ts
git commit -m "feat(web): update API routes for new recommendation format"
```

---

### Task 5: Rewrite Home.tsx — 3-column table

**Files:**
- Modify: `web/src/pages/Home.tsx`
- Modify: `web/src/hooks/useRecommendations.ts`

- [ ] **Step 1: Update useRecommendations hook types**

Replace `web/src/hooks/useRecommendations.ts`:

```typescript
import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";
import { useAuth } from "./useAuth";

interface RecommendationGroup {
  trend?: { id: string; title: string; platform: string; score: number; similarity: number };
  content?: { id: string; title: string; similarity: number };
  product?: { id: string; title: string; similarity: number };
  sort_score: number;
}

export function useRecommendations() {
  const { user } = useAuth();
  const [recommendations, setRecommendations] = useState<RecommendationGroup[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.recommendations.get();
      setRecommendations(res.recommendations);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh, user?.preferred_location]);

  return { recommendations, loading, refresh };
}
```

- [ ] **Step 2: Rewrite Home.tsx as 3-column table**

Replace `web/src/pages/Home.tsx`:

```tsx
import { useRecommendations } from "../hooks/useRecommendations";

function ScoreBadge({ score }: { score: number }) {
  return (
    <span className="text-xs font-mono bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded">
      {(score * 100).toFixed(0)}%
    </span>
  );
}

export function Home() {
  const { recommendations, loading } = useRecommendations();

  if (loading) {
    return <div className="max-w-5xl mx-auto p-8"><p className="text-gray-500">Loading recommendations...</p></div>;
  }

  if (recommendations.length === 0) {
    return (
      <div className="max-w-5xl mx-auto p-8">
        <h1 className="text-2xl font-bold mb-4">Recommendations</h1>
        <p className="text-gray-500">No recommendations yet. Import content and products, then wait for trend matching.</p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-8">
      <h1 className="text-2xl font-bold mb-6">Top Recommendations</h1>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b text-left">
            <th className="py-2 px-3 font-medium w-1/3">Trend</th>
            <th className="py-2 px-3 font-medium w-1/3">Content</th>
            <th className="py-2 px-3 font-medium w-1/3">Product</th>
          </tr>
        </thead>
        <tbody>
          {recommendations.map((group, i) => (
            <tr key={i} className="border-b hover:bg-gray-50">
              <td className="py-3 px-3">
                {group.trend ? (
                  <div>
                    <div className="font-medium">{group.trend.title}</div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-gray-400">{group.trend.platform}</span>
                      {group.trend.similarity < 1 && <ScoreBadge score={group.trend.similarity} />}
                    </div>
                  </div>
                ) : (
                  <span className="text-gray-300">—</span>
                )}
              </td>
              <td className="py-3 px-3">
                {group.content ? (
                  <div>
                    <div className="font-medium truncate max-w-xs">{group.content.title}</div>
                    <ScoreBadge score={group.content.similarity} />
                  </div>
                ) : (
                  <span className="text-gray-300">—</span>
                )}
              </td>
              <td className="py-3 px-3">
                {group.product ? (
                  <div>
                    <div className="font-medium truncate max-w-xs">{group.product.title}</div>
                    <ScoreBadge score={group.product.similarity} />
                  </div>
                ) : (
                  <span className="text-gray-300">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Build frontend**

```bash
cd web && npm run build
```

Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add web/src/
git commit -m "feat(web): 3-column recommendation table (Trend | Content | Product)"
```

---

### Task 6: Deploy and verify

- [ ] **Step 1: Run all tests**

```bash
cd web && npx vitest run
```

Expected: All tests PASS

- [ ] **Step 2: Deploy**

```bash
cd web && npm run build && npx wrangler deploy --env dev
```

- [ ] **Step 3: Trigger trend fetch**

```bash
curl -s 'https://trend-skill-dev.zhengchao-qqqqq.workers.dev/admin/trigger-fetch' \
  -X POST -H 'Authorization: Bearer uniscrm-admin-2026'
```

- [ ] **Step 4: Trigger recommendation recompute**

Login and re-import a content item (or call settings PATCH) to trigger recompute.

- [ ] **Step 5: Verify in browser**

Open https://web-dev.uni-scrm.com — should see 3-column table with Trend | Content | Product.
