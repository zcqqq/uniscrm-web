import { authFetch } from "../../../shared/frontend/lib/auth-fetch";

const BASE = "/api/reports";

async function request<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await authFetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error((data as any).error || `HTTP ${res.status}`);
  return data as T;
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

export interface IntervalPeriodStats extends IntervalStats {
  period: string;
}

export interface IntervalResults {
  sql?: string;
  periods: IntervalPeriodStats[];
  total_profiles: number;
  total_pairs: number;
  summary?: number;
}

export interface EventAnalysisParams {
  event_type: string;
  measure: "count" | "users" | "avg";
  dimension?: string;
  granularity: "day" | "week" | "month";
  time_range_start?: string;
  time_range_end?: string;
}

export interface EventAnalysisResults {
  sql: string;
  data: { period: string; value: number; dimension?: string }[];
  summary?: number;
}

export interface ReportSummary {
  id: string;
  name: string | null;
  type: string;
  params: Record<string, unknown>;
  status: string;
  results: IntervalResults | EventAnalysisResults | null;
  error_message: string | null;
  computed_at: string | null;
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
  name?: string | null;
  type: string;
  params: Record<string, unknown>;
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

export function updateReport(id: string, body: {
  name?: string | null;
  type?: string;
  params?: Record<string, unknown>;
}) {
  return request<{ ok: boolean; requeued?: boolean }>(`${BASE}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function recomputeReport(id: string) {
  return request<{ ok: boolean }>(`${BASE}/${id}/recompute`, { method: "POST" });
}

// ============ Dashboards ============

export interface Dashboard {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface DashboardItem {
  id: string;
  report_id: string;
  report_name: string | null;
  type: string;
  params: Record<string, unknown> | null;
  results: EventAnalysisResults | IntervalResults | null;
  status: string;
  size: string;
  position: number;
}

export function listDashboards() {
  return request<{ dashboards: Dashboard[] }>("/api/dashboards");
}

export function createDashboard(name: string) {
  return request<{ dashboard: { id: string; name: string } }>("/api/dashboards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export function getDashboard(id: string) {
  return request<{ dashboard: Dashboard; items: DashboardItem[] }>(`/api/dashboards/${id}`);
}

export function deleteDashboard(id: string) {
  return request<{ ok: boolean }>(`/api/dashboards/${id}`, { method: "DELETE" });
}

export function addDashboardItem(dashboardId: string, reportId: string, size = "medium") {
  return request<{ item: { id: string } }>(`/api/dashboards/${dashboardId}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ report_id: reportId, size }),
  });
}

export function updateDashboardItem(itemId: string, updates: { size?: string; position?: number }) {
  return request<{ ok: boolean }>(`/api/dashboard-items/${itemId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
}

export function deleteDashboardItem(itemId: string) {
  return request<{ ok: boolean }>(`/api/dashboard-items/${itemId}`, { method: "DELETE" });
}
