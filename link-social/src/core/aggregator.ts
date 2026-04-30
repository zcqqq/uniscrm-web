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
