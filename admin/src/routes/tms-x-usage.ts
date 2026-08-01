import type { Context } from "hono";
import type { Env } from "../types";

const CACHE_TTL_SECONDS = 600;

// 平台级 X API 用量。X 自身即返回最近 90 天的日粒度数据，因此不落库；
// 短缓存只是为了挡住连点刷新，避免打满 X 的限流。
export async function tmsXUsageRoute(c: Context<{ Bindings: Env }>) {
  const daysRaw = c.req.query("days");
  const days = daysRaw === undefined ? 30 : Number(daysRaw);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    return c.json({ error: "days must be an integer between 1 and 90" }, 400);
  }

  const cache = typeof caches !== "undefined" ? caches.default : undefined;
  // 自造 cache key，不复用真实请求 URL，免得和受 Access 保护的路径响应混淆。
  const cacheKey = new Request(`https://cache.internal/x-usage?days=${days}`);

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      return new Response(hit.body, {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Cache": "HIT" },
      });
    }
  }

  const res = await fetch(`${c.env.LINK_URL}/internal/x-usage?days=${days}`, {
    headers: { "X-Internal-Secret": c.env.INTERNAL_SECRET },
  });
  const text = await res.text();

  if (!res.ok) {
    console.error(JSON.stringify({
      event: "tms_x_usage_upstream_error",
      status: res.status,
      body: text.slice(0, 1000),
    }));
    // link 会把 X 的 401/429 统一映射成它自己的 502，X 的真实状态藏在 body 的
    // upstream_status 里。只透传 res.status 会让前端永远看不到 X 的状态。
    let inner: { error?: string; upstream_status?: number } = {};
    try {
      inner = JSON.parse(text) as typeof inner;
    } catch {
      inner = {};
    }
    return c.json(
      {
        error: inner.error ?? "upstream_error",
        link_status: res.status,
        upstream_status: inner.upstream_status ?? res.status,
      },
      502
    );
  }

  if (cache) {
    await cache.put(
      cacheKey,
      new Response(text, {
        headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_TTL_SECONDS}` },
      })
    );
  }

  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "application/json", "X-Cache": "MISS" },
  });
}
