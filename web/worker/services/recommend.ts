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

  async computeForUser(tenantId: number, location: string = "global"): Promise<void> {
    const namespace = `tenant-${tenantId}`;

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
          namespace,
          filter: { type: "content" },
          topK: 3,
          returnMetadata: "all",
        }),
        this.vectorize.query(trendVec, {
          namespace,
          filter: { type: "product" },
          topK: 3,
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
    await this.kv.put(`recommendations:tenant-${tenantId}`, JSON.stringify(top10));
  }

  async getForTenant(tenantId: number): Promise<RecommendationGroup[]> {
    const cached = await this.kv.get(`recommendations:tenant-${tenantId}`);
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
