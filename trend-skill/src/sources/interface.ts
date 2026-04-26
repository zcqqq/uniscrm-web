import type { TrendItem } from "../types";

export interface FetchTrendsOptions {
  category?: string;
  limit?: number;
}

export interface TrendSource {
  platform: string;
  fetchTrends(options?: FetchTrendsOptions): Promise<TrendItem[]>;
  isAvailable(): Promise<boolean>;
}
