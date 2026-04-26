import type { Env, TrendItem, WriteFormat, Tier } from "../types";
import { TrendCache } from "../storage/cache";
import { TrendVectorStore } from "../storage/vectorize";
import { listFormats, renderTemplate } from "../core/templates";

export async function handleListPlatforms() {
  return {
    platforms: [{ name: "twitter", status: "active", description: "X/Twitter trends via API v2" }],
  };
}

export async function handleListFormats() {
  return { formats: listFormats() };
}

export async function handleQueryTrends(
  env: Env,
  args: { platform?: string; category?: string; limit?: number }
) {
  const cache = new TrendCache(env.TREND_KV);
  const limit = args.limit ?? 20;

  if (args.platform) {
    const items = await cache.getPlatformLatest(args.platform);
    return { trends: (items ?? []).slice(0, limit) };
  }

  const items = await cache.getLatest();
  return { trends: (items ?? []).slice(0, limit) };
}

export async function handleSearchTrends(
  env: Env,
  args: { query: string; limit?: number }
) {
  const vectorStore = new TrendVectorStore(env.TREND_VECTORIZE, env.AI);
  const results = await vectorStore.search(args.query, args.limit ?? 20);
  return { results };
}

export async function handleGetTrendDetail(env: Env, args: { id: string }) {
  const cache = new TrendCache(env.TREND_KV);
  const all = await cache.getLatest();
  const item = all?.find((t) => t.id === args.id);
  if (!item) return { error: "Trend not found" };
  return { trend: item };
}

export async function handleGetWriteContext(
  env: Env,
  args: { trendIds: string[]; format: WriteFormat; locale?: string; tone?: string; audience?: string },
  tier: "anonymous" | Tier
) {
  if (tier !== "premium") {
    return { error: "Premium tier required. Upgrade your API key to use writing features." };
  }

  const cache = new TrendCache(env.TREND_KV);
  const all = await cache.getLatest();
  const idSet = new Set(args.trendIds);
  const trends = (all ?? []).filter((t) => idSet.has(t.id));

  const template = renderTemplate(args.format, trends, {
    tone: args.tone,
    locale: args.locale ?? "zh-CN",
    audience: args.audience,
  });

  return {
    trends,
    template,
    format: args.format,
    locale: args.locale ?? "zh-CN",
  };
}

export async function handleTrendingNow(env: Env, args: { limit?: number }) {
  return handleQueryTrends(env, { limit: args.limit ?? 20 });
}

export async function handleWriteFromTrend(
  env: Env,
  args: { query: string; format: WriteFormat; locale?: string; tone?: string; audience?: string },
  tier: "anonymous" | Tier
) {
  if (tier !== "premium") {
    return { error: "Premium tier required. Upgrade your API key to use writing features." };
  }

  const vectorStore = new TrendVectorStore(env.TREND_VECTORIZE, env.AI);
  const results = await vectorStore.search(args.query, 5);
  const trends = results.map((r) => r.item);

  const template = renderTemplate(args.format, trends, {
    tone: args.tone,
    locale: args.locale ?? "zh-CN",
    audience: args.audience,
  });

  return {
    trends,
    template,
    format: args.format,
    locale: args.locale ?? "zh-CN",
  };
}
