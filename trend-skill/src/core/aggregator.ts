import type { TrendItem } from "../types";
import type { TrendSource } from "../sources/interface";
import { normalize } from "./normalizer";

export interface AggregateResult {
  items: TrendItem[];
  failures: string[];
}

export class Aggregator {
  constructor(private sources: TrendSource[]) {}

  async fetchAll(limit = 50): Promise<AggregateResult> {
    const results = await Promise.allSettled(
      this.sources.map(async (source) => {
        const items = await source.fetchTrends({ limit });
        return { platform: source.platform, items };
      })
    );

    const allItems: TrendItem[] = [];
    const failures: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        const normalized = normalize(result.value.items);
        allItems.push(...normalized);
      } else {
        failures.push(this.sources[i].platform);
      }
    }

    allItems.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });

    return { items: allItems, failures };
  }
}
