import type { Platform, TrendItem } from "../types";

export interface TrendSource {
  platform: Platform;
  fetchTrends(): Promise<TrendItem[]>;
  isAvailable(): Promise<boolean>;
}
