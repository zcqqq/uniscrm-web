import type { Env } from "../types";
import { MARKETING_SKILLS_REPO } from "../skills/catalog";
import { listRecentTenantContent, type RecentContentRow } from "./tenant-content";
import { generateContent } from "./generate";
import { listConfiguredProviders } from "./llm-credentials";
// 哨兵字符串的唯一定义处在 shared/（前端 content/frontend/lib/context-block.ts 也从这里
// import）——两侧各写一份字面量会悄悄失配，且失配时没有任何报错，只是保存按钮永远不出现。
import { CONTEXT_SENTINEL } from "../../../shared/marketing-context-sentinel";

export const PRODUCT_MARKETING_SKILL_ID = "marketingskills-product-marketing";
export { MARKETING_SKILLS_REPO, CONTEXT_SENTINEL };

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

// 哨兵写在围栏的语言标签位，而不是认 ```markdown：模型在对话里会为了举例输出各种
// markdown 块，只有这个串明确表示"这是可保存的成品文档"。
//
// 不在这里手动拼租户现有文档：generateContent() 已经按 skillId 对应的 repo 自动注入了同一份
// skill_context 行（见 generate.ts 的 tenantContext），紧挨在这段合同文本之前。这里只需用
// 指代性措辞告诉模型"如果上文出现了当前文档就更新它"，覆盖有/无文档两种情况，不重复内联文档
// 本身——否则每一轮对话都会把整份文档在 system prompt 里放两遍，白烧 token 且随文档增长恶化。
export function buildChatContract(): string {
  return (
    "You are interviewing this user to produce their Product Marketing Context document." +
    " If their current document appears above this instruction, update it rather than starting" +
    " over from scratch; if none appears above, you are starting fresh." +
    " Ask about one section at a time; never dump every question at once." +
    " When — and only when — you have enough to write the full document, output it as a fenced" +
    ` code block whose info string is exactly ${CONTEXT_SENTINEL}, containing the complete markdown` +
    " document and nothing else. Until then, do not emit a block with that info string."
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
