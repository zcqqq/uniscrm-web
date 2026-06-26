export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  WEB_URL: string;
  CF_ACCOUNT_ID: string;
  CF_D1_API_TOKEN: string;
}

export interface IntervalAnalysis {
  id: string;
  tenant_id: number;
  member_id: string;
  event_type_a: string;
  event_type_b: string;
  time_range_start: string | null;
  time_range_end: string | null;
  status: string;
  total_profiles: number;
  processed_profiles: number;
  pair_count: number;
  results_json: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntervalResults {
  stats: IntervalStats;
  buckets: BucketItem[];
  total_profiles: number;
  total_pairs: number;
}

export interface IntervalStats {
  count: number;
  min: number;
  max: number;
  avg: number;
  median: number;
  p25: number;
  p75: number;
  p90: number;
}

export interface BucketItem {
  label: string;
  rangeStart: number;
  rangeEnd: number;
  count: number;
  percentage: number;
}
