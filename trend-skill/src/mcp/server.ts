import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env, Tier } from "../types";
import {
  handleTrendingNow,
  handleSearchTrends,
  handleQueryTrends,
  handleGetTrendDetail,
  handleGetDailyDigest,
} from "./tools";

export function createMcpServer(env: Env, tier: Tier): McpServer {
  const server = new McpServer({
    name: "trend-skill",
    version: "0.1.0",
  });

  server.tool("list_platforms", "List active trend platforms", {}, async () => ({
    content: [{ type: "text", text: JSON.stringify({ platforms: ["twitter"] }) }],
  }));

  server.tool(
    "trending_now",
    "Get top trending topics right now",
    {
      location: z.string().optional().describe("Filter by location (global, china)"),
      language: z.string().optional().describe("Filter by language (en, zh)"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async (params) => {
      const result = await handleTrendingNow(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "search_trends",
    "Semantic search for trends (requires auth)",
    {
      query: z.string().describe("Search query"),
      platform: z.string().optional(),
      location: z.string().optional(),
      language: z.string().optional(),
      limit: z.number().optional(),
    },
    async (params) => {
      if (tier === "anonymous") {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Authentication required" }) }] };
      }
      const result = await handleSearchTrends(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "query_trends",
    "Query trends with filters (requires auth)",
    {
      platform: z.string().optional(),
      location: z.string().optional(),
      language: z.string().optional(),
      date: z.string().optional().describe("Filter by date (YYYY-MM-DD)"),
      limit: z.number().optional(),
    },
    async (params) => {
      if (tier === "anonymous") {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Authentication required" }) }] };
      }
      const result = await handleQueryTrends(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "get_trend_detail",
    "Get details for a specific trend by ID (requires auth)",
    { id: z.string().describe("Trend ID") },
    async (params) => {
      if (tier === "anonymous") {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Authentication required" }) }] };
      }
      const result = await handleGetTrendDetail(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result ?? { error: "Not found" }) }] };
    }
  );

  server.tool("get_daily_digest", "Get today's trend digest (persistent and cross-platform topics)", {}, async () => {
    const result = await handleGetDailyDigest(env);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  return server;
}
