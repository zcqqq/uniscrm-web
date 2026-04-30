import type { ContentMatch, TrendMatch } from "../types";

interface ContentRef {
  id: string;
  title: string;
}

export class RecommendService {
  constructor(
    private db: D1Database,
    private vectorize: VectorizeIndex,
    private kv: KVNamespace
  ) {}

  async computeForUser(userId: string, location: string = "global"): Promise<void> {
    const { results: contents } = await this.db
      .prepare("SELECT id, title FROM content_items WHERE user_id = ?")
      .bind(userId)
      .all<ContentRef>();

    if (contents.length === 0) return;

    const ids = contents.map((c) => c.id);
    const allVectors: VectorizeVector[] = [];
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      const result = await this.vectorize.getByIds(batch);
      allVectors.push(...result);
    }
    const vectorMap = new Map(allVectors.map((v) => [v.id, v.values]));

    const recommendations: ContentMatch[] = [];

    for (const content of contents) {
      const values = vectorMap.get(content.id);
      if (!values) continue;

      const result = await this.vectorize.query(values, {
        filter: { type: "trend", location },
        topK: 5,
        returnMetadata: "all",
      });

      const matches: TrendMatch[] = result.matches.map((m) => ({
        trend_id: m.id,
        title: (m.metadata?.title as string) ?? "",
        platform: (m.metadata?.platform as string) ?? "",
        location: (m.metadata?.location as string) ?? "",
        similarity: m.score,
      }));

      if (matches.length > 0) {
        recommendations.push({
          content_id: content.id,
          title: content.title,
          matches,
        });
      }
    }

    await this.kv.put(`recommendations:${userId}`, JSON.stringify(recommendations));
  }

  async getForUser(userId: string): Promise<ContentMatch[]> {
    const cached = await this.kv.get(`recommendations:${userId}`);
    if (!cached) return [];

    const recommendations = JSON.parse(cached) as ContentMatch[];
    return recommendations.sort((a, b) => {
      const aMax = Math.max(...a.matches.map((m) => m.similarity));
      const bMax = Math.max(...b.matches.map((m) => m.similarity));
      return bMax - aMax;
    });
  }
}
