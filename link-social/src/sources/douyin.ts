import type { Platform, TrendItem } from "../types";
import { generateTrendId } from "../types";
import type { TrendSource } from "./interface";

const DOUYIN_CREATIVE_URL = "https://creator.douyin.com/creator-micro/creative-guidance?discover_menu=2";
const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v1/scrape";

const JSON_SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rank: { type: "number", description: "排名" },
          title: { type: "string", description: "热点标题" },
          heat: { type: "string", description: "热度值，如784.1万" },
          category: { type: "string", description: "所属分类" },
        },
      },
    },
  },
};

interface DouyinNote {
  rank?: number;
  title?: string;
  heat?: string;
  category?: string;
}

export class DouyinTrendSource implements TrendSource {
  platform: Platform = "douyin";

  constructor(
    private firecrawlApiKey: string,
    private cookie: string,
    private categories: string[]
  ) {}

  async fetchTrends(): Promise<TrendItem[]> {
    const today = new Date().toISOString().slice(0, 10);
    const allItems: TrendItem[] = [];

    for (const category of this.categories) {
      try {
        const items = await this.scrapeTrends(today, category);
        allItems.push(...items);
      } catch (e) {
        console.error(`Douyin scrape failed for ${category}: ${e}`);
      }
    }

    return allItems;
  }

  private async scrapeTrends(today: string, category: string): Promise<TrendItem[]> {
    const response = await fetch(FIRECRAWL_SCRAPE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.firecrawlApiKey}`,
      },
      body: JSON.stringify({
        url: DOUYIN_CREATIVE_URL,
        formats: ["json"],
        jsonOptions: { schema: JSON_SCHEMA },
        headers: { Cookie: this.cookie },
        actions: [
          { type: "click", selector: "更多" },
          { type: "click", selector: category },
          { type: "wait", milliseconds: 2000 },
          { type: "scroll", direction: "down", amount: 3 },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Firecrawl API error ${response.status}: ${text}`);
    }

    const result = await response.json() as {
      success: boolean;
      data?: { json?: { notes?: DouyinNote[] } };
    };

    if (!result.success || !result.data?.json?.notes) {
      return [];
    }

    return result.data.json.notes
      .filter((n) => n.title && n.title.length >= 2)
      .map((n) => {
        const heat = n.heat ? parseChineseMetric(n.heat) : 0;
        const id = generateTrendId(today, "douyin", "china", n.title!);
        return {
          id,
          platform: "douyin" as Platform,
          location: "china",
          language: "zh",
          title: n.title!,
          score: heat || (n.rank ?? 0),
          metrics: { heat },
          categories: [n.category ?? category],
          timestamp: new Date().toISOString(),
        };
      });
  }

  async isAvailable(): Promise<boolean> {
    return this.firecrawlApiKey.length > 0 && this.cookie.length > 0;
  }
}

function parseChineseMetric(raw: string): number {
  const cleaned = raw.replace(/,/g, "").trim();
  if (cleaned.includes("亿")) {
    return Math.round(parseFloat(cleaned.replace("亿", "")) * 100_000_000);
  }
  if (cleaned.includes("万")) {
    return Math.round(parseFloat(cleaned.replace("万", "")) * 10_000);
  }
  return parseInt(cleaned, 10) || 0;
}
