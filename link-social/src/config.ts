import trendConfig from "../trend.json";

export interface TwitterLocationConfig {
  id: string;
  label: string;
  language: string;
  shortCode: string;
  woeid: number;
}

export interface TikTokLocationConfig {
  id: string;
  label: string;
  language: string;
  shortCode: string;
}

export interface TwitterConfig {
  locations: TwitterLocationConfig[];
}

export interface TikTokConfig {
  locations: TikTokLocationConfig[];
  categories: string[];
}

export interface DouyinConfig {
  location: { id: string; language: string; shortCode: string };
  categories: string[];
}

const TWITTER_LOCATIONS: Record<string, TwitterLocationConfig> = {
  global: { id: "global", label: "Global", language: "en", shortCode: "gl", woeid: 1 },
  china: { id: "china", label: "China", language: "zh", shortCode: "cn", woeid: 23424781 },
};

const TIKTOK_LOCATIONS: Record<string, TikTokLocationConfig> = {
  "All regions": { id: "all_regions", label: "All regions", language: "en", shortCode: "ar" },
  "United States": { id: "united_states", label: "United States", language: "en", shortCode: "us" },
};

export function getTwitterConfig(): TwitterConfig | null {
  for (const entry of trendConfig) {
    if ("TWITTER" in entry) {
      const raw = entry.TWITTER as { locations: string[] };
      const locations = raw.locations
        .map((name) => TWITTER_LOCATIONS[name])
        .filter(Boolean);
      return { locations };
    }
  }
  return null;
}

export function getTikTokConfig(): TikTokConfig | null {
  for (const entry of trendConfig) {
    if ("TIKTOK" in entry) {
      const raw = entry.TIKTOK as { locations: string[]; categories: string[] };
      const locations = raw.locations
        .map((name) => TIKTOK_LOCATIONS[name])
        .filter(Boolean);
      return { locations, categories: raw.categories };
    }
  }
  return null;
}

export function getDouyinConfig(): DouyinConfig | null {
  for (const entry of trendConfig) {
    if ("DOUYIN" in entry) {
      const raw = entry.DOUYIN as { categories: string[] };
      return {
        location: { id: "china", language: "zh", shortCode: "cn" },
        categories: raw.categories,
      };
    }
  }
  return null;
}
