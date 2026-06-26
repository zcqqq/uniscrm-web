const BASE = "/api/reports";

async function request<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...opts });
  const data = await res.json();
  if (!res.ok) throw new Error((data as any).error || `HTTP ${res.status}`);
  return data as T;
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
  sql?: string;
  stats: IntervalStats;
  buckets: BucketItem[];
  total_profiles: number;
  total_pairs: number;
}

export interface ReportSummary {
  id: string;
  type: string;
  params: {
    event_type_a?: string;
    event_type_b?: string;
    time_range_start?: string;
    time_range_end?: string;
  };
  status: string;
  results: IntervalResults | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export function listReports(page = 1, type?: string) {
  const qs = type ? `&type=${type}` : "";
  return request<{ reports: ReportSummary[]; total: number; page: number; totalPages: number }>(
    `${BASE}?page=${page}${qs}`
  );
}

export function getReport(id: string) {
  return request<{ report: ReportSummary }>(`${BASE}/${id}`);
}

export function createReport(body: {
  type: string;
  params: {
    event_type_a: string;
    event_type_b: string;
    time_range_start?: string;
    time_range_end?: string;
  };
}) {
  return request<{ report: { id: string; status: string } }>(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteReport(id: string) {
  return request<{ ok: boolean }>(`${BASE}/${id}`, { method: "DELETE" });
}
