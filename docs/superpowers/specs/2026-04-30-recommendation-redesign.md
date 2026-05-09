# Recommendation Service Redesign

## Context

Current recommendations find the best trend for each content item. The new design reverses the direction: take the top 10 trends, find the best matching content AND commerce product for each, then rank all combinations using a triangle similarity algorithm. Results display in a fixed 3-column table (Trend | Content | Product).

## Algorithm

### Input

Top 10 trends from KV `trends:latest`, sorted by score descending, filtered by user's `preferred_location`.

### Per-Trend Matching

For each trend (has embedding in Vectorize with `type: "trend"`):

1. Query Vectorize `filter: {type: "content", user_id}` topK=1 → best content + score `s_tc` (trend↔content)
2. Query Vectorize `filter: {type: "product", user_id}` topK=1 → best product + score `s_tp` (trend↔product)
3. If both content and product found, fetch their embeddings via `getByIds`, compute cosine similarity → `s_cp` (content↔product)

### Triangle Ranking

For each trend's result set (3 scores: `s_tc`, `s_tp`, `s_cp`):

1. Sort the 3 scores, compute median (middle value) and mean (average)
2. If `mean >= median` → all three items are mutually relevant → **3-column group** (trend + content + product), sort score = mean
3. If `mean < median` → take the pair with the highest score:
   - If highest is `s_tc` → group = trend + content
   - If highest is `s_tp` → group = trend + product
   - If highest is `s_cp` → group = content + product (no trend)
   - Sort score = highest pair score

Edge cases:
- No content found for user → skip content column, only trend + product
- No product found for user → skip product column, only trend + content
- Neither found → skip this trend entirely

### Output

Sort all groups by sort score descending, take top 10.

## Data Types

### RecommendationGroup (new, replaces ContentMatch)

```typescript
interface RecommendationGroup {
  trend?: { id: string; title: string; platform: string; score: number; similarity: number };
  content?: { id: string; title: string; similarity: number };
  product?: { id: string; title: string; similarity: number };
  sort_score: number;
}
```

### API Response

```
GET /api/recommendations → { recommendations: RecommendationGroup[] }
```

## Backend Changes

### File: `web/worker/services/recommend.ts`

Complete rewrite of `computeForUser`:

1. Read top 10 trends from KV `trends:latest` (parse JSON, sort by score, filter by location, take 10)
2. For each trend, get its embedding from Vectorize (batch `getByIds` on trend IDs)
3. For each trend embedding, query content and product matches (2 Vectorize queries each)
4. For pairs with both content and product, compute content↔product cosine similarity
5. Apply triangle ranking logic
6. Sort and take top 10
7. Cache to KV `recommendations:{userId}`

`getForUser` simplified: just read from KV and return (already sorted during compute).

### Cosine Similarity Helper

Add a `cosineSimilarity(a: number[], b: number[]): number` function for content↔product comparison. This is a pure math function (dot product / magnitudes).

### File: `web/worker/types.ts`

- Remove `ContentMatch` and `TrendMatch`
- Add `RecommendationGroup`

### File: `web/worker/api/recommendations.ts`

No structural change, just returns `RecommendationGroup[]` instead of `ContentMatch[]`.

### Metadata Index

Need `user_id` metadata index on Vectorize for filtering content/product by user. Run:
```
wrangler vectorize create-metadata-index trend-embeddings-dev --property-name user_id --type string
```

## Frontend Changes

### File: `web/src/pages/Home.tsx`

Replace expandable card list with a 3-column table:

```
| Trend              | Content                    | Product                  |
|--------------------|----------------------------|--------------------------|
| GW初日 (twitter)   | AI技术趋势.md              | AI课程 - Udemy           |
| 77%                | 85%                        | 72%                      |
|--------------------|----------------------------|--------------------------|
| —                  | Web开发指南.md             | React教程               |
|                    | 91%                        | 88%                      |
```

- Each cell: title + similarity % badge
- Empty cells when that column is absent from the group
- Rows sorted by sort_score (already sorted from API)

### File: `web/src/hooks/useRecommendations.ts`

Update type from old `Recommendation` to `RecommendationGroup`.

## Vectorize Query Budget

Per computation: 10 trends × (1 content query + 1 product query) + up to 10 getByIds calls = ~30 Vectorize operations. Well within free tier.

## Verification

1. `cd web && npx vitest run` — tests pass
2. Import content + products for a user
3. Trigger trend fetch
4. Open Home page → see 3-column table with recommendations
5. Change location → recommendations refresh with filtered trends
6. User with no content → only Trend + Product columns
7. User with no products → only Trend + Content columns
