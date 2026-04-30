import type { Env } from "./types";
import type { TrendSource } from "./sources/interface";
import { getTwitterConfig, getTikTokConfig, getDouyinConfig } from "./config";
import { TwitterTrendSource } from "./sources/twitter";
import { TikTokTrendSource } from "./sources/tiktok";
import { DouyinTrendSource } from "./sources/douyin";
import { Aggregator } from "./core/aggregator";
import { TrendCache } from "./storage/cache";
import { TrendVectorStore } from "./storage/vectorize";

interface CronResult {
  totalItems: number;
  platforms: string[];
  failedPlatforms: string[];
}

async function handleCron(env: Env): Promise<CronResult> {
  const sources: TrendSource[] = [];

  const twitterConfig = getTwitterConfig();
  if (twitterConfig && env.TWITTER_BEARER_TOKEN) {
    sources.push(new TwitterTrendSource(env.TWITTER_BEARER_TOKEN));
  }

  const tiktokConfig = getTikTokConfig();
  if (tiktokConfig && env.FIRECRAWL_API_KEY && env.TIKTOK_COOKIE) {
    sources.push(
      new TikTokTrendSource(
        env.FIRECRAWL_API_KEY,
        env.TIKTOK_COOKIE,
        tiktokConfig.locations,
        tiktokConfig.categories
      )
    );
  }

  const douyinConfig = getDouyinConfig();
  if (douyinConfig && env.FIRECRAWL_API_KEY && env.DOUYIN_COOKIE) {
    sources.push(
      new DouyinTrendSource(
        env.FIRECRAWL_API_KEY,
        env.DOUYIN_COOKIE,
        douyinConfig.categories
      )
    );
  }

  if (sources.length === 0) {
    console.log(JSON.stringify({ event: "link-social.no_sources", message: "No sources configured or secrets missing" }));
    return { totalItems: 0, platforms: [], failedPlatforms: [] };
  }

  const aggregator = new Aggregator(sources);
  const cache = new TrendCache(env.TREND_KV);
  const vectorStore = new TrendVectorStore(env.TREND_VECTORIZE, env.AI);

  const { items, failedPlatforms } = await aggregator.fetchAll();

  if (failedPlatforms.length > 0) {
    console.log(
      JSON.stringify({
        event: "link-social.fetch_partial_failure",
        failedPlatforms,
        successCount: items.length,
      })
    );
  }

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

  await vectorStore.upsertTrends(items);

  const retentionDays = parseInt(env.TREND_RETENTION_DAYS || "30", 10);
  await vectorStore.cleanupOld(retentionDays);

  const result: CronResult = {
    totalItems: items.length,
    platforms: [...new Set(items.map((i) => i.platform))],
    failedPlatforms,
  };

  console.log(JSON.stringify({ event: "link-social.cron_complete", ...result }));
  return result;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/trigger" && request.method === "POST") {
      try {
        const result = await handleCron(env);
        return Response.json({ status: "ok", ...result });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return Response.json({ status: "error", message: msg }, { status: 500 });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleCron(env));
  },
};
