import { Hono } from "hono";
import type { Env } from "./types";
import { Aggregator } from "./core/aggregator";
import { TwitterTrendSource } from "./sources/twitter";
import { TrendCache } from "./storage/cache";
import { TrendVectorStore } from "./storage/vectorize";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

async function handleCron(env: Env): Promise<void> {
  const source = new TwitterTrendSource(env.TWITTER_BEARER_TOKEN);
  const aggregator = new Aggregator([source]);
  const cache = new TrendCache(env.TREND_KV);
  const vectorStore = new TrendVectorStore(env.TREND_VECTORIZE, env.AI);

  const { items } = await aggregator.fetchAll();

  await cache.setLatest(items);

  const byPlatform = new Map<string, typeof items>();
  for (const item of items) {
    const list = byPlatform.get(item.platform) ?? [];
    list.push(item);
    byPlatform.set(item.platform, list);
  }
  for (const [platform, platformItems] of byPlatform) {
    await cache.setPlatformLatest(platform, platformItems);
  }

  await vectorStore.upsertTrends(items);
  await vectorStore.cleanupOld();
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleCron(env));
  },
};
