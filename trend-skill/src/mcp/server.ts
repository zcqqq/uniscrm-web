import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env, Tier, WriteFormat } from "../types";
import {
  handleListPlatforms,
  handleListFormats,
  handleQueryTrends,
  handleSearchTrends,
  handleGetTrendDetail,
  handleGetWriteContext,
  handleTrendingNow,
  handleWriteFromTrend,
} from "./tools";

export function createMcpServer(env: Env, tier: "anonymous" | Tier) {
  const server = new McpServer({ name: "trend-skill", version: "0.1.0" });

  server.tool("list_platforms", "返回已接入平台列表及状态", {}, async () => {
    const result = await handleListPlatforms();
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  server.tool("list_formats", "返回支持的写作格式列表", {}, async () => {
    const result = await handleListFormats();
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  server.tool(
    "query_trends",
    "按 platform/category/limit 筛选热点列表",
    {
      platform: z.string().optional().describe("Filter by platform (e.g. twitter)"),
      category: z.string().optional().describe("Filter by category"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async ({ platform, category, limit }) => {
      const result = await handleQueryTrends(env, { platform, category, limit });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "search_trends",
    "自然语言语义搜索热点",
    {
      query: z.string().describe("Natural language search query"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async ({ query, limit }) => {
      const result = await handleSearchTrends(env, { query, limit });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "get_trend_detail",
    "按 id 获取单条热点完整信息",
    { id: z.string().describe("Trend ID (e.g. twitter:123)") },
    async ({ id }) => {
      const result = await handleGetTrendDetail(env, { id });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "get_write_context",
    "获取写作上下文（需 premium）",
    {
      trendIds: z.array(z.string()).describe("Trend IDs to include"),
      format: z.enum(["tweet", "thread", "article", "summary", "headline"]),
      locale: z.string().optional(),
      tone: z.string().optional(),
      audience: z.string().optional(),
    },
    async ({ trendIds, format, locale, tone, audience }) => {
      const result = await handleGetWriteContext(
        env,
        { trendIds, format: format as WriteFormat, locale, tone, audience },
        tier
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "trending_now",
    "一键获取全平台 Top N 热点",
    { limit: z.number().optional().describe("Top N (default 20)") },
    async ({ limit }) => {
      const result = await handleTrendingNow(env, { limit });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "write_from_trend",
    "传入 query + format，自动匹配热点并返回 WriteContext（需 premium）",
    {
      query: z.string().describe("Topic to search for"),
      format: z.enum(["tweet", "thread", "article", "summary", "headline"]),
      locale: z.string().optional(),
      tone: z.string().optional(),
      audience: z.string().optional(),
    },
    async ({ query, format, locale, tone, audience }) => {
      const result = await handleWriteFromTrend(
        env,
        { query, format: format as WriteFormat, locale, tone, audience },
        tier
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  return server;
}
