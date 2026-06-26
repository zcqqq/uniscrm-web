const BASE = "/api/analyses";

async function request<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...opts });
  const data = await res.json();
  if (!res.ok) throw new Error((data as any).error || `HTTP ${res.status}`);
  return data as T;
}

export interface AnalysisSummary {
  id: string;
  event_type_a: string;
  event_type_b: string;
  time_range_start: string | null;
  time_range_end: string | null;
  status: string;
  total_profiles: number;
  pair_count: number;
  created_at: string;
}

export interface BucketItem {
  label: string;
  rangeStart: number;
  rangeEnd: number;
  count: number;
  percentage: number;
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

export interface IntervalResults {
  stats: IntervalStats;
  buckets: BucketItem[];
  total_profiles: number;
  total_pairs: number;
}

export interface AnalysisDetail extends AnalysisSummary {
  member_id: string;
  results: IntervalResults | null;
  error_message: string | null;
}

export function listAnalyses(page = 1) {
  return request<{ analyses: AnalysisSummary[]; total: number; page: number; totalPages: number }>(
    `${BASE}?page=${page}`
  );
}

export function getAnalysis(id: string) {
  return request<{ analysis: AnalysisDetail }>(`${BASE}/${id}`);
}

export function createAnalysis(body: {
  event_type_a: string;
  event_type_b: string;
  time_range_start?: string;
  time_range_end?: string;
}) {
  return request<{ analysis: { id: string; status: string; results?: IntervalResults } }>(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteAnalysis(id: string) {
  return request<{ ok: boolean }>(`${BASE}/${id}`, { method: "DELETE" });
}
