import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  ResponsiveContainer, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from "recharts";
import { createReport, getReport, listDashboards, addDashboardItem, type EventAnalysisResults, type Dashboard } from "../lib/api";
import AiGenerateBar from "../../../shared/frontend/components/AiGenerateBar";
import { EventMetadata_X, PROPS_X } from "../../../metadata/x";
import { t, type Locale } from "../../../metadata/locale";
import { useLocale } from "../hooks/useLocale";

const TRIGGER_EVENTS = EventMetadata_X.filter((e) => e.flowType !== "action");
const INSIGHT_PROPS = PROPS_X.filter((p) => p.isInsight);

const UI = {
  en: {
    save: "Save", cancel: "Cancel", selectEvent: "Select event...",
    measure: "Measure", dimension: "Dimension", noGroup: "No grouping",
    viewBy: "View by", totalCount: "Total count", uniqueUsers: "Unique users",
    perUserAvg: "Per-user avg", day: "Day", week: "Week", month: "Month",
    last7d: "Last 7 days", last14d: "Last 14 days", last30d: "Last 30 days", last90d: "Last 90 days",
    querying: "Querying...", noData: "No data", date: "Date", value: "Value",
    reportName: "Report name",
  },
  zh: {
    save: "保存", cancel: "取消", selectEvent: "选择事件...",
    measure: "选择指标", dimension: "选择维度", noGroup: "不分组",
    viewBy: "按", totalCount: "总次数", uniqueUsers: "总人数",
    perUserAvg: "人均次数", day: "按日", week: "按周", month: "按月",
    last7d: "过去7天", last14d: "过去14天", last30d: "过去30天", last90d: "过去90天",
    querying: "查询中...", noData: "无数据", date: "日期", value: "值",
    reportName: "请输入报表名称",
  },
};

const TIME_RANGES = [
  { value: "7", key: "last7d" as const },
  { value: "14", key: "last14d" as const },
  { value: "30", key: "last30d" as const },
  { value: "90", key: "last90d" as const },
];

const COLORS = ["hsl(var(--primary))", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];

export function EventAnalysisCreate() {
  const navigate = useNavigate();
  const { locale, timezone } = useLocale();
  const s = UI[locale];

  const [name, setName] = useState("");
  const [eventType, setEventType] = useState("");
  const [measure, setMeasure] = useState<"count" | "users" | "avg">("count");
  const [dimension, setDimension] = useState("");
  const [timeRange, setTimeRange] = useState("7");
  const [granularity, setGranularity] = useState<"day" | "week" | "month">("day");
  const [chartType, setChartType] = useState<"line" | "bar">("line");

  const [reportId, setReportId] = useState<string | null>(null);
  const [results, setResults] = useState<EventAnalysisResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [dashDropOpen, setDashDropOpen] = useState(false);

  useEffect(() => { listDashboards().then((d) => setDashboards(d.dashboards)); }, []);

  const runQuery = useCallback(async () => {
    if (!eventType) return;
    setLoading(true);
    setError("");
    setResults(null);

    const start = new Date(Date.now() - parseInt(timeRange) * 86400000).toISOString().slice(0, 10);

    try {
      const res = await createReport({
        type: "event",
        params: {
          event_type: eventType,
          measure,
          dimension: dimension || undefined,
          granularity,
          time_range_start: start,
        },
      });
      setReportId(res.report.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      setLoading(false);
    }
  }, [eventType, measure, dimension, timeRange, granularity]);

  useEffect(() => {
    if (!reportId) return;
    const poll = setInterval(async () => {
      try {
        const res = await getReport(reportId);
        if (res.report.status === "ready" && res.report.results) {
          setResults(res.report.results as EventAnalysisResults);
          setLoading(false);
          clearInterval(poll);
        } else if (res.report.status === "error") {
          setError(res.report.error_message || "Query failed");
          setLoading(false);
          clearInterval(poll);
        }
      } catch {}
    }, 2000);
    return () => clearInterval(poll);
  }, [reportId]);

  useEffect(() => {
    runQuery();
  }, [runQuery]);

  const formatPeriod = (period: string) => {
    try {
      return new Date(period).toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", { timeZone: timezone, month: "short", day: "numeric" });
    } catch {
      return period;
    }
  };

  const chartData = results?.data || [];
  const dimensions = [...new Set(chartData.filter((d) => d.dimension).map((d) => d.dimension!))];
  const hasDimension = dimensions.length > 0;

  const pivotedData = hasDimension
    ? Object.values(
        chartData.reduce((acc, row) => {
          if (!acc[row.period]) acc[row.period] = { period: row.period };
          acc[row.period][row.dimension || "value"] = row.value;
          return acc;
        }, {} as Record<string, Record<string, unknown>>)
      )
    : chartData.map((d) => ({ period: d.period, value: d.value }));

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center h-12 px-4 border-b border-border bg-card gap-3 shrink-0">
        <button onClick={() => navigate("/analytics")} className="text-sm text-muted-foreground hover:text-foreground">← Back</button>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={s.reportName}
          className="text-sm font-medium border-none outline-none bg-transparent w-40 min-w-0"
        />
        <AiGenerateBar endpoint="/api/reports/generate" placeholder={locale === "zh" ? "描述你想分析的..." : "Describe what to analyze..."} onResult={() => {}} />
        <button onClick={() => navigate("/analytics")} className="px-3 py-1.5 text-sm font-medium bg-primary text-white rounded hover:bg-primary/90 transition-colors">
          {s.save}
        </button>
        {reportId && (
          <div className="relative">
            <button onClick={() => setDashDropOpen(!dashDropOpen)} className="px-3 py-1.5 text-sm font-medium border border-border rounded hover:bg-muted transition-colors">
              + Dashboard
            </button>
            {dashDropOpen && (
              <div className="absolute right-0 mt-1 w-48 bg-card border border-border rounded-lg shadow-lg z-10 py-1">
                {dashboards.map((d) => (
                  <button
                    key={d.id}
                    onClick={async () => {
                      await addDashboardItem(d.id, reportId);
                      setDashDropOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors"
                  >
                    {d.name}
                  </button>
                ))}
                {dashboards.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">No dashboards</div>}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto p-6 max-w-6xl mx-auto w-full">

      {/* 2. Measure + Dimension */}
      <div className="bg-card rounded-lg border border-border p-5 mb-5">
        <div className="flex gap-8">
          <div className="flex-1">
            <div className="text-sm font-medium text-foreground mb-2">{s.measure}</div>
            <div className="flex items-center gap-2">
              <select value={eventType} onChange={(e) => setEventType(e.target.value)} className="border border-border rounded px-2 py-1.5 text-sm">
                <option value="">{s.selectEvent}</option>
                {TRIGGER_EVENTS.map((e) => <option key={e.eventType} value={e.eventType}>{t(e.label, locale)}</option>)}
              </select>
              <span className="text-muted-foreground text-sm">→</span>
              <select value={measure} onChange={(e) => setMeasure(e.target.value as any)} className="border border-border rounded px-2 py-1.5 text-sm">
                <option value="count">{s.totalCount}</option>
                <option value="users">{s.uniqueUsers}</option>
                <option value="avg">{s.perUserAvg}</option>
              </select>
            </div>
          </div>
          <div className="flex-1">
            <div className="text-sm font-medium text-foreground mb-2">{s.dimension}</div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">{s.viewBy}</span>
              <select value={dimension} onChange={(e) => setDimension(e.target.value)} className="border border-border rounded px-2 py-1.5 text-sm">
                <option value="">{s.noGroup}</option>
                {INSIGHT_PROPS.map((p) => <option key={p.propId} value={p.propId}>{t(p.label, locale)}</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* 3. Chart controls + Chart */}
      <div className="bg-card rounded-lg border border-border p-5 mb-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex gap-2">
            <select value={timeRange} onChange={(e) => setTimeRange(e.target.value)} className="border border-border rounded px-2 py-1.5 text-sm">
              {TIME_RANGES.map((r) => <option key={r.value} value={r.value}>{s[r.key]}</option>)}
            </select>
            <select value={granularity} onChange={(e) => setGranularity(e.target.value as any)} className="border border-border rounded px-2 py-1.5 text-sm">
              <option value="day">{s.day}</option>
              <option value="week">{s.week}</option>
              <option value="month">{s.month}</option>
            </select>
          </div>
          <div className="flex gap-0.5 border border-border rounded-md p-0.5">
            <button onClick={() => setChartType("line")} className={`p-1.5 rounded transition-colors ${chartType === "line" ? "bg-muted text-foreground" : "text-muted-foreground"}`}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><polyline points="1,11 4,7 7,9 10,3 13,5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <button onClick={() => setChartType("bar")} className={`p-1.5 rounded transition-colors ${chartType === "bar" ? "bg-muted text-foreground" : "text-muted-foreground"}`}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1" y="6" width="3" height="7" rx="0.5" /><rect x="5.5" y="3" width="3" height="10" rx="0.5" /><rect x="10" y="1" width="3" height="12" rx="0.5" /></svg>
            </button>
          </div>
        </div>

        {loading && <div className="text-center py-12 text-muted-foreground text-sm">{s.querying}</div>}
        {error && <div className="text-center py-12 text-destructive text-sm">{error}</div>}
        {!loading && !error && pivotedData.length === 0 && eventType && (
          <div className="text-center py-12 text-muted-foreground text-sm">{s.noData}</div>
        )}
        {!loading && pivotedData.length > 0 && (
          <ResponsiveContainer width="100%" height={240}>
            {chartType === "bar" ? (
              <BarChart data={pivotedData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" opacity={0.4} />
                <XAxis dataKey="period" tickFormatter={formatPeriod} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
                <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} labelFormatter={formatPeriod} />
                {hasDimension ? dimensions.map((dim, i) => (
                  <Bar key={dim} dataKey={dim} fill={COLORS[i % COLORS.length]} radius={[3, 3, 0, 0]} />
                )) : <Bar dataKey="value" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />}
                {hasDimension && <Legend />}
              </BarChart>
            ) : (
              <AreaChart data={pivotedData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" opacity={0.4} />
                <XAxis dataKey="period" tickFormatter={formatPeriod} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
                <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} labelFormatter={formatPeriod} />
                {hasDimension ? dimensions.map((dim, i) => (
                  <Area key={dim} type="monotone" dataKey={dim} stroke={COLORS[i % COLORS.length]} fill={COLORS[i % COLORS.length]} fillOpacity={0.1} strokeWidth={2} dot={false} />
                )) : <Area type="monotone" dataKey="value" stroke="hsl(var(--primary))" fill="hsl(var(--primary))" fillOpacity={0.1} strokeWidth={2} dot={{ r: 3 }} />}
                {hasDimension && <Legend />}
              </AreaChart>
            )}
          </ResponsiveContainer>
        )}
      </div>

      {/* 4. Table */}
      {!loading && pivotedData.length > 0 && (
        <div className="bg-card rounded-lg border border-border overflow-hidden mb-5">
          <table className="w-full text-sm">
            <thead className="bg-background border-b border-border">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">{s.date}</th>
                {hasDimension ? dimensions.map((dim) => (
                  <th key={dim} className="text-right px-4 py-2.5 font-medium text-muted-foreground">{dim}</th>
                )) : <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">{s.value}</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {pivotedData.map((row: any, i) => (
                <tr key={i} className="hover:bg-background">
                  <td className="px-4 py-2 text-foreground">{formatPeriod(row.period)}</td>
                  {hasDimension ? dimensions.map((dim) => (
                    <td key={dim} className="px-4 py-2 text-right text-foreground">{row[dim] ?? 0}</td>
                  )) : <td className="px-4 py-2 text-right text-foreground">{row.value}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* SQL */}
      {results?.sql && (
        <details className="bg-card rounded-lg border border-border p-5">
          <summary className="text-sm font-medium text-foreground cursor-pointer">SQL Query</summary>
          <pre className="mt-3 p-3 bg-muted rounded text-xs text-muted-foreground overflow-x-auto whitespace-pre-wrap font-mono">{results.sql}</pre>
        </details>
      )}
      </div>
    </div>
  );
}
