import type { TrendItem, WriteFormat } from "../types";

export interface PromptTemplate {
  format: WriteFormat;
  description: string;
  template: string;
  maxLength?: number;
}

const TEMPLATES: Record<WriteFormat, PromptTemplate> = {
  tweet: {
    format: "tweet",
    description: "单条推文，不超过 280 字符，可含 hashtag",
    template: `基于以下热点话题，撰写一条推文（不超过280字符）。
要求：简洁有力，可包含 hashtag，语气{tone}。

热点数据：
{trends}

请直接输出推文内容。`,
    maxLength: 280,
  },
  thread: {
    format: "thread",
    description: "推文串 3-5 条，[1/N] 格式",
    template: `基于以下热点话题，撰写一组推文串（3-5条），形成连贯叙事。

热点数据：
{trends}

格式要求：每条推文以 [1/N] 开头，单条不超过280字符，语气{tone}。`,
  },
  article: {
    format: "article",
    description: "博客文章 800-1500 字，含标题/引言/正文/总结",
    template: `基于以下热点话题，撰写一篇 {locale} 的博客文章（800-1500字）。

热点数据：
{trends}

要求：有标题、引言、正文、总结。语气{tone}，目标读者{audience}。`,
  },
  summary: {
    format: "summary",
    description: "热点摘要 200-400 字",
    template: `基于以下热点话题，撰写一份摘要（200-400字），语言 {locale}。

热点数据：
{trends}

要求：概述核心事件和影响，语气{tone}，目标读者{audience}。`,
  },
  headline: {
    format: "headline",
    description: "新闻标题，一行",
    template: `基于以下热点话题，撰写一个新闻标题（一行），语言 {locale}。

热点数据：
{trends}

要求：吸引眼球，准确概括，语气{tone}。`,
    maxLength: 100,
  },
};

const DEFAULTS: Record<string, string> = {
  tone: "professional",
  locale: "zh-CN",
  audience: "general",
};

function serializeTrends(trends: TrendItem[]): string {
  return trends
    .map(
      (t) =>
        `- [${t.score}分] ${t.title}${t.description ? ` — ${t.description}` : ""}\n  链接: ${t.url}`
    )
    .join("\n");
}

export function getTemplate(format: WriteFormat): PromptTemplate {
  return TEMPLATES[format];
}

export function listFormats(): Pick<PromptTemplate, "format" | "description">[] {
  return Object.values(TEMPLATES).map(({ format, description }) => ({ format, description }));
}

export function renderTemplate(
  format: WriteFormat,
  trends: TrendItem[],
  options: Partial<Record<string, string>>
): string {
  const tpl = TEMPLATES[format];
  let result = tpl.template;
  result = result.replace(/\{trends\}/g, serializeTrends(trends));
  for (const [key, defaultVal] of Object.entries(DEFAULTS)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), options[key] ?? defaultVal);
  }
  return result;
}
