import { Hono } from "hono";
import type { Env } from "./types";
import { createTrendsRouter } from "./api/trends";
import { createAdminRouter } from "./api/admin";
import { resolveAuth } from "./auth/middleware";
import { RateLimiter } from "./auth/rate-limit";
import { createMcpServer } from "./mcp/server";
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

app.get("/mcp", (c) =>
  c.json({ error: "Method not allowed. Use POST for MCP requests." }, 405)
);

app.post("/mcp", async (c) => {
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

  const parsedBody = await c.req.json();
  const msg = parsedBody as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  const rpcMethod = msg.method ?? "";
  let toolName = "";
  let toolArgs: Record<string, unknown> = {};
  if (rpcMethod === "tools/call") {
    toolName = msg.params?.name ?? "";
    toolArgs = msg.params?.arguments ?? {};
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

export default {
  fetch: app.fetch,
};
