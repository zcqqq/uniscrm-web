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
