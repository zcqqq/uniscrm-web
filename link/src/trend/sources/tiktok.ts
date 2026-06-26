import type { Platform, TrendItem } from "../types";
import { generateTrendId } from "../types";
import type { TikTokLocationConfig } from "../config";
import type { TrendSource } from "./interface";

const TIKTOK_TRENDING_URL = "https://www.tiktok.com/tiktokstudio/inspiration/trending";
const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v1/scrape";

const JSON_SCHEMA = {
  type: "object",
  properties: {
    trends: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rank: { type: "number", description: "Ranking position" },
          title: { type: "string", description: "Trend or hashtag name" },
          views: { type: "string", description: "View count, e.g. 1.2M" },
          posts: { type: "string", description: "Number of posts or videos" },
        },
      },
    },
  },
};

interface TikTokTrend {
  rank?: number;
  title?: string;
  views?: string;
  posts?: string;
}

export class TikTokTrendSource implements TrendSource {
  platform: Platform = "tiktok";

  constructor(
    private firecrawlApiKey: string,
    private cookie: string,
    private locations: TikTokLocationConfig[],
    private categories: string[]
  ) {}

  async fetchTrends(): Promise<TrendItem[]> {
    const today = new Date().toISOString().slice(0, 10);
    const allItems: TrendItem[] = [];

    for (const loc of this.locations) {
      for (const category of this.categories) {
        try {
          const items = await this.scrapeTrends(today, loc, category);
          allItems.push(...items);
        } catch (e) {
          console.error(`TikTok scrape failed for ${loc.label}/${category}: ${e}`);
        }
      }
    }

    return allItems;
  }

  private async scrapeTrends(
    today: string,
    location: TikTokLocationConfig,
    category: string
  ): Promise<TrendItem[]> {
    const response = await fetch(FIRECRAWL_SCRAPE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.firecrawlApiKey}`,
      },
      body: JSON.stringify({
        url: TIKTOK_TRENDING_URL,
        formats: ["json"],
        jsonOptions: { schema: JSON_SCHEMA },
        headers: { Cookie: this.cookie },
        actions: [
          { type: "click", selector: location.label },
          { type: "wait", milliseconds: 1000 },
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
      data?: { json?: { trends?: TikTokTrend[] } };
    };

    if (!result.success || !result.data?.json?.trends) {
      return [];
    }

    return result.data.json.trends
      .filter((t) => t.title && t.title.length >= 2)
      .map((t) => {
        const views = t.views ? parseMetricValue(t.views) : 0;
        const id = generateTrendId(today, "tiktok", location.id, t.title!);
        return {
          id,
          platform: "tiktok" as Platform,
          location: location.id,
          language: location.language,
          title: t.title!,
          score: views || (t.rank ?? 0),
          metrics: { views },
          categories: [category],
          timestamp: new Date().toISOString(),
        };
      });
  }

  async isAvailable(): Promise<boolean> {
    return this.firecrawlApiKey.length > 0 && this.cookie.length > 0;
  }
}

function parseMetricValue(raw: string): number {
  const cleaned = raw.replace(/,/g, "").trim();
  const match = cleaned.match(/^([\d.]+)\s*([KMBkmb])?$/);
  if (!match) return parseInt(cleaned, 10) || 0;

  const num = parseFloat(match[1]);
  const suffix = (match[2] ?? "").toUpperCase();
  const multipliers: Record<string, number> = { K: 1_000, M: 1_000_000, B: 1_000_000_000 };
  return Math.round(num * (multipliers[suffix] ?? 1));
}
