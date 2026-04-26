import { Hono } from "hono";
import type { Env } from "./types";
import { Aggregator } from "./core/aggregator";
import { TwitterTrendSource } from "./sources/twitter";
import { TrendCache } from "./storage/cache";
import { TrendVectorStore } from "./storage/vectorize";
import { createTrendsRouter } from "./api/trends";
import { createContextRouter } from "./api/context";
import { createAdminRouter } from "./api/admin";
import { resolveAuth } from "./auth/middleware";
import { RateLimiter } from "./auth/rate-limit";
import { createMcpServer } from "./mcp/server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

app.use("/api/*", async (c, next) => {
  const apiKey = c.req.header("X-API-Key");
  const authResult = await resolveAuth(apiKey, c.env.TREND_DB);

  if ("error" in authResult) {
    return c.json({ error: authResult.error }, authResult.status as 401 | 403);
  }

  const identifier = authResult.identifier ?? c.req.header("CF-Connecting-IP") ?? "unknown";
  const limiter = new RateLimiter(c.env.TREND_KV);
  const rateResult = await limiter.check(identifier, authResult.tier);

  if (!rateResult.allowed) {
    return c.json(
      { error: "Rate limit exceeded", retryAfterSeconds: rateResult.retryAfterSeconds },
      429
    );
  }

  c.set("tier" as never, authResult.tier);
  await next();
});

app.route("/api", createTrendsRouter());
app.route("/api", createContextRouter());
app.route("/admin", createAdminRouter());

app.all("/mcp", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  const authResult = await resolveAuth(apiKey, c.env.TREND_DB);

  let tier: "anonymous" | "free" | "premium" = "anonymous";
  if (!("error" in authResult)) {
    tier = authResult.tier;
  }

  const server = createMcpServer(c.env, tier);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

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
