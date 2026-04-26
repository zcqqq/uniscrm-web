import type { TrendItem, TrendSearchResult } from "../types";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const MAX_24H_MS = 24 * 60 * 60 * 1000;
const MAX_48H_MS = 48 * 60 * 60 * 1000;

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
    const embedResult = await this.ai.run(EMBEDDING_MODEL, { text: texts }) as { data: number[][] };
    const vectors = embedResult.data;

    const records = items.map((item, i) => ({
      id: item.id,
      values: vectors[i],
      metadata: { item: JSON.stringify(item) },
    }));

    await this.vectorize.upsert(records);
  }

  async search(query: string, limit = 20): Promise<TrendSearchResult[]> {
    const cappedLimit = Math.min(limit, 50);
    const embedResult = await this.ai.run(EMBEDDING_MODEL, { text: [query] }) as { data: number[][] };
    const queryVector = embedResult.data[0];

    const matches = await this.vectorize.query(queryVector, {
      topK: cappedLimit,
      returnMetadata: "all",
    });

    const now = Date.now();
    return matches.matches
      .map((m) => {
        const item: TrendItem = JSON.parse(m.metadata!.item as string);
        return { item, similarity: m.score };
      })
      .filter((r) => now - new Date(r.item.timestamp).getTime() < MAX_24H_MS);
  }

  async cleanupOld(): Promise<void> {
    const now = Date.now();
    const allResults = await this.vectorize.query(new Array(768).fill(0), {
      topK: 50,
      returnMetadata: "all",
    });

    const staleIds = allResults.matches
      .filter((m) => {
        const item: TrendItem = JSON.parse(m.metadata!.item as string);
        return now - new Date(item.timestamp).getTime() > MAX_48H_MS;
      })
      .map((m) => m.id);

    if (staleIds.length > 0) {
      await this.vectorize.deleteByIds(staleIds);
    }
  }
}
