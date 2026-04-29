import { Hono } from "hono";
import type { Env } from "./types";
import { createTrendsRouter } from "./api/trends";
import { createAdminRouter } from "./api/admin";
import { resolveAuth } from "./auth/middleware";
import { RateLimiter } from "./auth/rate-limit";
import { Aggregator } from "./core/aggregator";
import { TwitterTrendSource } from "./sources/twitter";
import { TrendCache } from "./storage/cache";
import { TrendVectorStore } from "./storage/vectorize";
import { buildDailyDigest } from "./push/digest";
import { sendWebhook } from "./push/webhook";
import { createMcpServer } from "./mcp/server";
import type { DigestPayload } from "./types";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

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
app.route("/admin", createAdminRouter());

app.post("/admin/trigger-fetch", async (c) => {
  const auth = c.req.header("Authorization");
  if (auth !== `Bearer ${c.env.ADMIN_SECRET}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  try {
    await handleCron(c.env);
    return c.json({ status: "ok", message: "Fetch pipeline completed" });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ status: "error", message: msg }, 500);
  }
});

app.all("/mcp", async (c) => {
  const startMs = Date.now();
  const apiKey = c.req.header("X-API-Key");
  const authResult = await resolveAuth(apiKey, c.env.TREND_DB);

  let tier: "anonymous" | "free" | "premium" = "anonymous";
  if (!("error" in authResult)) {
    tier = authResult.tier;
  }

  const server = createMcpServer(c.env, tier);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);

  const accept = c.req.header("Accept") ?? "";
  const headers = new Headers(c.req.raw.headers);
  if (!accept.includes("text/event-stream")) {
    headers.set("Accept", "application/json, text/event-stream");
  }

  let parsedBody: unknown;
  let rpcMethod = "";
  let toolName = "";
  let toolArgs: Record<string, unknown> = {};

  if (c.req.method === "POST") {
    parsedBody = await c.req.json();
    const msg = parsedBody as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    rpcMethod = msg.method ?? "";
    if (rpcMethod === "tools/call") {
      toolName = msg.params?.name ?? "";
      toolArgs = msg.params?.arguments ?? {};
    }
  }

  const req = new Request(c.req.url, { method: c.req.method, headers });
  const response = await transport.handleRequest(req, { parsedBody });

  if (rpcMethod === "tools/call" && toolName) {
    console.log(JSON.stringify({
      event: "mcp.tool_call",
      tool: toolName,
      args: toolArgs,
      tier,
      durationMs: Date.now() - startMs,
      status: response.status,
    }));
  }

  return response;
});

async function handleCron(env: Env): Promise<void> {
  const source = new TwitterTrendSource(env.TWITTER_BEARER_TOKEN);
  const aggregator = new Aggregator([source]);
  const cache = new TrendCache(env.TREND_KV);
  const vectorStore = new TrendVectorStore(env.TREND_VECTORIZE, env.AI);

  const { items } = await aggregator.fetchAll();

  // 1. KV: overwrite latest snapshots
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

  // 2. Vectorize: upsert trends
  await vectorStore.upsertTrends(items);

  // 3. Vectorize: cleanup expired data
  const retentionDays = parseInt(env.TREND_RETENTION_DAYS || "30", 10);
  await vectorStore.cleanupOld(retentionDays);

  // 4. Push: daily digest webhook
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const yesterdayResults = await vectorStore.search("", 50, { date: yesterday });
  const digest = await buildDailyDigest(vectorStore, yesterdayResults.map((r) => r.item), today);

  const payload: DigestPayload = {
    event: "trend.daily_digest",
    timestamp: new Date().toISOString(),
    data: digest,
  };

  await sendWebhook(env.WEBHOOK_URL, env.WEBHOOK_SECRET, payload);
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleCron(env));
  },
};
