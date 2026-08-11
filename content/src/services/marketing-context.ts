import type { Env } from "../types";
import { MARKETING_SKILLS_REPO } from "../skills/catalog";
import { listRecentTenantContent, type RecentContentRow } from "./tenant-content";
import { generateContent } from "./generate";

export const PRODUCT_MARKETING_SKILL_ID = "marketingskills-product-marketing";
export const CONTEXT_SENTINEL = "PRODUCT-MARKETING-CONTEXT-V1";
export { MARKETING_SKILLS_REPO };

export interface ChannelSummaryRow {
  channelType: string;
  displayName: string | null;
}

// 渠道摘要是"锦上添花"的第二路信号；link 挂了就当没有，内容那一路还在。
export async function fetchChannelSummary(env: Env, tenantId: number): Promise<ChannelSummaryRow[]> {
  try {
    const res = await fetch(`${env.LINK_URL}/internal/channels/summary?tenantId=${tenantId}`, {
      headers: { "X-Internal-Secret": env.INTERNAL_SECRET },
    });
    if (!res.ok) return [];
    return (await res.json<{ channels: ChannelSummaryRow[] }>()).channels ?? [];
  } catch (err) {
    console.error(JSON.stringify({ event: "channel_summary_fetch_failed", tenantId, error: String(err) }));
    return [];
  }
}

export function buildDraftPrompt(rows: RecentContentRow[], channels: ChannelSummaryRow[]): string {
  const channelLines = channels
    .map((c) => `- ${c.channelType}${c.displayName ? `: ${c.displayName}` : ""}`)
    .join("\n");
  const contentLines = rows
    .map((r) => `- [${r.channelType}] ${r.title ?? ""}\n  ${(r.contentText ?? "").slice(0, 500)}`)
    .join("\n");

  return [
    "Draft a Product Marketing Context document for this tenant, following your skill's 12-section structure.",
    "You have no codebase to read. Everything known about them is below. Where a section cannot be",
    "supported by this evidence, write a short best guess and mark it clearly as an assumption to confirm.",
    channels.length ? `\nConnected marketing channels:\n${channelLines}` : "",
    rows.length ? `\nTheir most recent published/ingested content:\n${contentLines}` : "",
  ].filter(Boolean).join("\n");
}

export async function draftMarketingContext(env: Env, tenantId: number): Promise<string> {
  const [rows, channels] = await Promise.all([
    listRecentTenantContent(env, tenantId),
    fetchChannelSummary(env, tenantId),
  ]);
  // 两个信号都空 = 这个租户我们一无所知。生成一份纯靠猜的文档只会给用户一堆要删的东西，
  // 不如把对话交回给他们从白纸开始。
  if (rows.length === 0 && channels.length === 0) return "";

  return generateContent(env, {
    tenantId,
    prompt: buildDraftPrompt(rows, channels),
    // "default" 是占位——Task 6 会引入 resolveContextProvider(env, tenantId)，让起草和对话
    // 两个端点共用同一个"跟随租户已配置文本模型"的解析结果。本任务先按 default 实现。
    provider: "default",
    skillId: PRODUCT_MARKETING_SKILL_ID,
  });
}
