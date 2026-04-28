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
      topK: 50,
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
