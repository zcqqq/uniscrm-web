export interface ContainerInstance {
  startAndWaitForPorts(): Promise<void>;
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

export interface ContainerNamespace {
  getByName(name: string): ContainerInstance;
}

export interface Env {
  WEB_DB: D1Database;
  ANALYTICS_DB: D1Database;
  ASSETS: Fetcher;
  WEB_URL: string;
  CF_ACCOUNT_ID: string;
  CF_D1_API_TOKEN: string;
  R2_WAREHOUSE: string;
  ANALYTICS_CONTAINER: ContainerNamespace;
  ANALYTICS_QUEUE: Queue;
}

export interface AnalyticsReport {
  id: string;
  tenant_id: number;
  member_id: string;
  type: string;
  params_json: string;
  status: string;
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
