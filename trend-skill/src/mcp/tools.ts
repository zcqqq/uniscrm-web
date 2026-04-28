import type { TrendItem, Env } from "../types";
import { TrendVectorStore } from "../storage/vectorize";
import { buildDailyDigest } from "../push/digest";

export async function handleTrendingNow(
  env: Env,
  params: { location?: string; language?: string; limit?: number }
): Promise<{ items: TrendItem[] }> {
  const raw = await env.TREND_KV.get("trends:latest");
  let items: TrendItem[] = raw ? JSON.parse(raw) : [];

  if (params.location) items = items.filter((t) => t.location === params.location);
  if (params.language) items = items.filter((t) => t.language === params.language);

  return { items: items.slice(0, params.limit ?? 20) };
}

export async function handleSearchTrends(
  env: Env,
  params: { query: string; platform?: string; location?: string; language?: string; limit?: number }
): Promise<{ results: { item: TrendItem; similarity: number }[] }> {
  const store = new TrendVectorStore(env.TREND_VECTORIZE, env.AI);
  const filter: Record<string, string> = {};
  if (params.platform) filter.platform = params.platform;
  if (params.location) filter.location = params.location;
  if (params.language) filter.language = params.language;

  const results = await store.search(
    params.query,
    params.limit ?? 20,
    Object.keys(filter).length > 0 ? filter : undefined
  );

  return { results };
}

export async function handleQueryTrends(
  env: Env,
  params: { platform?: string; location?: string; language?: string; date?: string; limit?: number }
): Promise<{ items: TrendItem[] }> {
  const store = new TrendVectorStore(env.TREND_VECTORIZE, env.AI);
  const filter: Record<string, string> = {};
  if (params.platform) filter.platform = params.platform;
  if (params.location) filter.location = params.location;
  if (params.language) filter.language = params.language;
  if (params.date) filter.date = params.date;

  const results = await store.search("", params.limit ?? 20, Object.keys(filter).length > 0 ? filter : undefined);
  return { items: results.map((r) => r.item) };
}

export async function handleGetTrendDetail(
  env: Env,
  params: { id: string }
): Promise<TrendItem | null> {
  const store = new TrendVectorStore(env.TREND_VECTORIZE, env.AI);
  const results = await store.search(params.id, 1);
  return results.length > 0 ? results[0].item : null;
}

export async function handleGetDailyDigest(
  env: Env
): Promise<{ persistent_topics: any[]; cross_platform_topics: any[] }> {
  const store = new TrendVectorStore(env.TREND_VECTORIZE, env.AI);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const yesterdayResults = await store.search("", 100, { date: yesterday });
  const yesterdayItems = yesterdayResults.map((r) => r.item);

  return buildDailyDigest(store, yesterdayItems, today);
}
