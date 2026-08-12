import type { Env } from "../types";
import { MARKETING_SKILLS_REPO } from "../skills/catalog";
import { listRecentTenantContent, type RecentContentRow } from "./tenant-content";
import { generateContent } from "./generate";
import { listConfiguredProviders } from "./llm-credentials";

export const PRODUCT_MARKETING_SKILL_ID = "marketingskills-product-marketing";
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
    provider: await resolveContextProvider(env, tenantId),
    skillId: PRODUCT_MARKETING_SKILL_ID,
  });
}

// 对话与起草都跟随租户已配置的文本模型：配了 BYOK 就用 BYOK，没配就用免费默认。
// 与全站一致，不引入"这个功能专用的模型"这种新概念。
export async function resolveContextProvider(
  env: Env,
  tenantId: number
): Promise<"default" | "openai" | "anthropic"> {
  const configured = await listConfiguredProviders(env, tenantId);
  if (configured.some((p) => p.provider === "anthropic")) return "anthropic";
  if (configured.some((p) => p.provider === "openai")) return "openai";
  return "default";
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// 哨兵围栏契约在 dev 实测 0/6 合规后删除（详见设计文档 §8.1–§8.2）：技能自带的 9KB 指令里
// 就有"展示完整文档"这一条，跟我们哨兵契约的"先别写"直接打架，模型选择听技能的。文档生成
// 改走独立的 /generate 端点（见 generateMarketingContextDocument），聊天这条路径此后只负责
// 提问，不再兼职吐文档。
//
// 不在这里手动拼租户现有文档：generateContent() 已经按 skillId 对应的 repo 自动注入了同一份
// skill_context 行（见 generate.ts 的 tenantContext），紧挨在这段合同文本之前。这里只需用
// 指代性措辞告诉模型"如果上文出现了当前文档就更新它"，覆盖有/无文档两种情况，不重复内联文档
// 本身——否则每一轮对话都会把整份文档在 system prompt 里放两遍，白烧 token 且随文档增长恶化。
export function buildChatContract(): string {
  return (
    "You are interviewing this user to produce their Product Marketing Context document." +
    " You have no filesystem and no tools; do not propose saving a file or reading a codebase." +
    " If their current document appears above this instruction, update it rather than starting" +
    " over from scratch; if none appears above, you are starting fresh." +
    " Ask about one section at a time; never dump every question at once."
  );
}

// 生成文档的契约里刻意不出现任何小节名、字段名或文档结构——技能内容会随公开仓库改版，
// 我们必须永远适配最新版，硬编码它的结构等于把自己焊死在某个快照上。结构的权威完全交还
// "上文的指令"（技能全文，由 generateContent 按 skillId 自动注入，见 generate.ts）；这份
// 契约只描述我们自己运行时缺什么（文件系统、工具）以及响应体的形状（纯文档、无解释、无围栏）。
export function buildDocumentContract(): string {
  return (
    "You have no filesystem and no tools. Do not propose saving a file or reading a codebase." +
    " The user's current document, if any, appears above this instruction." +
    " Output the complete document itself now — no explanation, no code fence, no alternatives —" +
    " following the structure the instructions above describe."
  );
}

export function buildChatPrompt(messages: ChatMessage[]): string {
  return messages.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");
}

export async function chatMarketingContext(env: Env, tenantId: number, messages: ChatMessage[]): Promise<string> {
  return generateContent(env, {
    tenantId,
    prompt: buildChatPrompt(messages),
    provider: await resolveContextProvider(env, tenantId),
    skillId: PRODUCT_MARKETING_SKILL_ID,
    operationContext: buildChatContract(),
  });
}

// 文档始终活在编辑框里，对话只是修改它的手段：这一步是单独一次调用，响应体本身就是完整文档，
// 直接覆盖编辑框——不需要哨兵、不需要解析、不存在合规率。messages 允许为空（用户可能起草完
// 就直接点"生成文档"，一句话都没说）；此时给一句占位提示而不是空字符串，因为部分 provider
// （如 Anthropic）的 API 拒绝空 content 的 user turn。
export async function generateMarketingContextDocument(
  env: Env,
  tenantId: number,
  messages: ChatMessage[]
): Promise<string> {
  return generateContent(env, {
    tenantId,
    prompt: messages.length ? buildChatPrompt(messages) : "Generate the document now.",
    provider: await resolveContextProvider(env, tenantId),
    skillId: PRODUCT_MARKETING_SKILL_ID,
    operationContext: buildDocumentContract(),
  });
}
