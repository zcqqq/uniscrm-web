import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ResponsiveContainer, LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell, BarChart, Bar, Legend } from "recharts";
import { createReport, getReport, updateReport, listDashboards, createDashboard, addDashboardItem, type Dashboard } from "../lib/api";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
import { useLocale } from "../hooks/useLocale";
import { ReportConfig, type ReportConfigValues } from "../components/ReportConfig";
import { fillTimeSeries } from "../lib/fill-time-series";
import { Button } from "../../../shared/frontend/ui/button";
import { Input } from "../../../shared/frontend/ui/input";
import { Card, CardContent } from "../../../shared/frontend/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../../shared/frontend/ui/table";
import { Progress } from "../../../shared/frontend/ui/progress";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../../../shared/frontend/ui/dropdown-menu";
import { DIMENSION_COLORS } from "../../../shared/frontend/lib/colors";

const MODE_TITLES: Record<string, { en: string; zh: string }> = {
  event: { en: "Event Analysis", zh: "事件分析" },
  interval: { en: "Interval Analysis", zh: "间隔分析" },
  user: { en: "User Analysis", zh: "用户分析" },
};

export function AnalyticsDetail({ mode: modeProp }: { mode?: "event" | "interval" | "user" | "funnel" }) {
  const { id: paramId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { locale, timezone } = useLocale();
  const { toast } = useToast();

  const [mode, setMode] = useState<"event" | "interval" | "user" | "funnel">(modeProp || "event");
  const [name, setName] = useState(() => (paramId ? "" : `Untitled ${MODE_TITLES[mode]?.en || "Analysis"}`));
  const [chartType, setChartType] = useState<"pie" | "bar">("pie");
  const [eventChartType, setEventChartType] = useState<"line" | "bar">("line");
  const [config, setConfig] = useState<ReportConfigValues>({
    mode,
    eventType: "",
    measure: "count",
    eventTypeA: "",
    eventTypeB: "",
    dimension: "",
    timeRange: "7",
    granularity: "day",
  });

  const [reportId, setReportId] = useState<string | null>(paramId || null);
  const [results, setResults] = useState<any>(null);
  const [loading, setLoading] = useState(!!paramId);
  const [error, setError] = useState("");
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [dashDropOpen, setDashDropOpen] = useState(false);
  const [initialized, setInitialized] = useState(!paramId);
  const [saving, setSaving] = useState(false);

  const title = MODE_TITLES[mode]?.[locale] || MODE_TITLES[mode]?.en || mode;
  useEffect(() => { document.title = `${title} — UniSCRM`; }, [title]);

  // Load existing report if navigated with :id
  useEffect(() => {
    if (!paramId) return;
    getReport(paramId).then((d) => {
      const r = d.report;
      setReportId(r.id);
      setMode((r.type as any) || "event");
      setName(r.name || (r.params as any).name || `${r.type} #${r.id.slice(0, 8)}`);
      const p = r.params as any;
      setConfig({
        mode: (r.type as any) || "event",
        eventType: p.event_type || "",
        measure: p.measure || "count",
        measureField: p.measure_field || undefined,
        eventTypeA: p.event_type_a || "",
        eventTypeB: p.event_type_b || "",
        dimension: p.dimension || "",
        buckets: Array.isArray(p.buckets) ? p.buckets.join(",") : (p.buckets || ""),
        timeRange: typeof p.time_range === "string" && p.time_range ? p.time_range : inferTimeRange(p.time_range_start || ""),
        granularity: p.granularity || "day",
        compareEnabled: !!p.compare_enabled,
        compareTimeRange: p.compare_time_range || "7",
        filters: p.filters,
        funnelSteps: Array.isArray(p.steps) ? p.steps : undefined,
        windowValue: p.window_value || undefined,
        windowUnit: p.window_unit || undefined,
      });
      if (r.results) setResults(r.results);
      setLoading(r.status === "pending" || r.status === "computing");
      if (r.status === "error") setError(r.error_message || "Error");
      setInitialized(true);
    }).catch((e) => { setError(e.message); setLoading(false); setInitialized(true); });
  }, [paramId]);

  useEffect(() => { listDashboards().then((d) => setDashboards(d.dashboards)); }, []);

  const buildReportParams = useCallback((): Record<string, unknown> => {
    const numericDays = Number.parseInt(config.timeRange, 10);
    const start = Number.isFinite(numericDays)
      ? new Date(Date.now() - numericDays * 86400000).toISOString().slice(0, 10)
      : undefined;
    const reportName = name.trim();

    if (mode === "funnel") {
      return {
        steps: (config.funnelSteps || []).filter(Boolean),
        window_value: config.windowValue || 7,
        window_unit: config.windowUnit || "day",
        time_range: config.timeRange,
        time_range_start: start,
        compare_enabled: !!config.compareEnabled,
        compare_time_range: config.compareTimeRange || undefined,
        filters: config.filters,
        name: reportName || undefined,
      };
    }
    if (mode === "user") {
      const buckets = config.buckets ? config.buckets.split(",").map(Number).filter(n => !isNaN(n) && n > 0) : undefined;
      return {
        measure: config.measure,
        measure_field: config.measureField || undefined,
        dimension: config.dimension || undefined,
        buckets: buckets?.length ? buckets : undefined,
        filters: config.filters,
        name: reportName || undefined,
      };
    }
    if (mode === "interval") {
      return {
        event_type_a: config.eventTypeA,
        event_type_b: config.eventTypeB,
        dimension: config.dimension || undefined,
        granularity: config.granularity,
        time_range: config.timeRange,
        time_range_start: start,
        compare_enabled: !!config.compareEnabled,
        compare_time_range: config.compareTimeRange || undefined,
        filters: config.filters,
        name: reportName || undefined,
      };
    }

    return {
      event_type: config.eventType,
      measure: config.measure,
      dimension: config.dimension || undefined,
      granularity: config.granularity,
      time_range: config.timeRange,
      time_range_start: start,
      compare_enabled: !!config.compareEnabled,
      compare_time_range: config.compareTimeRange || undefined,
      filters: config.filters,
      name: reportName || undefined,
    };
  }, [config, mode, name]);

  const runQuery = useCallback(async () => {
    if (mode === "interval" && (!config.eventTypeA || !config.eventTypeB)) return;
    if (mode === "event" && !config.eventType) return;
    if (mode === "funnel" && (!config.funnelSteps || config.funnelSteps.filter(Boolean).length < 2)) return;
    setLoading(true);
    setError("");
    setResults(null);

    try {
      const params = buildReportParams();
      const res = await createReport({ type: mode, params });
      setReportId(res.report.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      setLoading(false);
    }
  }, [buildReportParams, config, mode]);

  useEffect(() => {
    if (!reportId) return;
    
    // Poll regardless of loading state - polling continues until results available or error occurs
    const poll = setInterval(async () => {
      try {
        const res = await getReport(reportId);
        if (res.report.status === "ready" && res.report.results) {
          setResults(res.report.results);
          setLoading(false);
          clearInterval(poll);
        } else if (res.report.status === "error") {
          setError(res.report.error_message || "Query failed");
          setLoading(false);
          clearInterval(poll);
        } else if (res.report.status === "pending" || res.report.status === "computing") {
          // Keep polling
          setLoading(true);
        }
      } catch {}
    }, 2000);
    
    return () => clearInterval(poll);
  }, [reportId]);

  useEffect(() => {
    if (!initialized) return;
    if (paramId) return; // existing reports: always poll, never auto-create a new report
    runQuery();
  }, [runQuery, initialized]);

  const handleSave = async () => {
    if (!reportId) {
      navigate("/analytics");
      return;
    }

    const normalizedName = name.trim();
    setSaving(true);
    try {
      const params = buildReportParams();
      await updateReport(reportId, { name: normalizedName || null, type: mode, params });
      toast({ description: locale === "zh" ? "已保存" : "Saved" });
      navigate("/analytics");
    } catch (err) {
      const message = err instanceof Error ? err.message : (locale === "zh" ? "保存失败" : "Save failed");
      toast({ variant: "destructive", description: message });
    } finally {
      setSaving(false);
    }
  };

  const formatPeriod = (p: unknown) => {
    if (!p || typeof p !== "string") return String(p ?? "");
    try {
      const normalized = p.replace(/(\.\d{3})\d+Z$/, "$1Z");
      // Bare date strings (YYYY-MM-DD) must be parsed as UTC midnight
      const dateStr = normalized.includes("T") ? normalized : `${normalized}T00:00:00Z`;
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return p.slice(0, 10);

      if (config.granularity === "week") {
        const weekEnd = new Date(d.getTime() + 6 * 86400000);
        const fmt = (dt: Date) =>
          dt.toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", {
            timeZone: "UTC",
            month: "short",
            day: "numeric",
          });
        return `${fmt(d)} – ${fmt(weekEnd)}`;
      }

      return d.toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", { timeZone: timezone, month: "short", day: "numeric" });
    } catch { return p.slice(0, 10); }
  };

  const hasStats = results && "stats" in results;
  const hasData = results && "data" in results;
  const chartData = hasData ? fillTimeSeries(results.data, config.timeRange, config.granularity) : [];
  const hasDimension = hasData && results.data?.some((d: any) => d.dimension != null);
  const dimensions: string[] = hasDimension
    ? Array.from(new Set(results.data.map((d: any) => String(d.dimension ?? "null"))))
    : [];
  // For multi-dimension pivot data by period; for single dimension use filled time series
  const eventData: any[] = hasDimension
    ? (() => {
        const byPeriod = new Map<string, Record<string, any>>();
        for (const d of results.data) {
          const cleaned = String(d.period || "").replace(/(\.\d{3})\d+Z$/, "$1Z");
          const dateStr = cleaned.includes("T") ? cleaned : `${cleaned}T00:00:00Z`;
          const key = new Date(dateStr).toISOString().slice(0, 10);
          if (!byPeriod.has(key)) byPeriod.set(key, { period: key });
          (byPeriod.get(key) as Record<string, any>)[String(d.dimension ?? "null")] = d.value || 0;
        }
        return Array.from(byPeriod.values()).sort((a, b) => a.period.localeCompare(b.period));
      })()
    : chartData;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center h-12 px-4 border-b border-border bg-card gap-3 shrink-0">
        <Button variant="ghost" size="sm" onClick={() => navigate("/analytics")}>← Back</Button>
        <Input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8 w-52 min-w-0 border-none bg-transparent font-medium"
        />
        <div className="flex-1" />
        <DropdownMenu open={dashDropOpen} onOpenChange={setDashDropOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={!reportId}>Add to Dashboard</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={async () => {
              const name = prompt(locale === "zh" ? "输入仪表盘名称" : "Dashboard name");
              if (!name || !reportId) return;
              const res = await createDashboard(name);
              await addDashboardItem(res.dashboard.id, reportId);
              setDashboards((prev) => [{ id: res.dashboard.id, name, created_at: "", updated_at: "" }, ...prev]);
              toast({ description: `${locale === "zh" ? "已添加到" : "Added to"} ${name}` });
            }}>
              <span className="text-primary font-medium">+ {locale === "zh" ? "新建仪表盘" : "New Dashboard"}</span>
            </DropdownMenuItem>
            {dashboards.map((d) => (
              <DropdownMenuItem key={d.id} onClick={async () => {
                if (!reportId) return;
                await addDashboardItem(d.id, reportId);
                toast({ description: `${locale === "zh" ? "已添加到" : "Added to"} ${d.name}` });
              }}>
                {d.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" onClick={handleSave} disabled={saving || !reportId}>
          {saving ? (locale === "zh" ? "保存中..." : "Saving...") : "Save"}
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <ReportConfig values={config} onChange={setConfig} mode={mode} />

        {loading && (
          <div className="flex items-center justify-center py-16">
            <div className="flex items-center gap-3 text-muted-foreground">
              <div className="h-4 w-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="text-sm">{locale === "zh" ? "查询中..." : "Computing..."}</span>
            </div>
          </div>
        )}
        {error && (
          <Card className="border-destructive/50 bg-destructive/5 mb-4">
            <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
          </Card>
        )}

        {/* Interval results — KPI cards + distribution chart */}
        {hasStats && (
          <>
            <div className="grid gap-4 grid-cols-2 sm:grid-cols-4 mb-4">
              {[
                { label: "Pairs", value: results.stats.count.toLocaleString() },
                { label: "Profiles", value: results.total_profiles.toLocaleString() },
                { label: "Median", value: fmt(results.stats.median) },
                { label: "Average", value: fmt(results.stats.avg) },
              ].map((item) => (
                <Card key={item.label}>
                  <CardContent className="p-4">
                    <p className="text-xs font-medium text-muted-foreground">{item.label}</p>
                    <p className="text-2xl font-bold tracking-tight mt-1">{item.value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
            <div className="grid gap-4 grid-cols-5 mb-4">
              {[
                { label: "P25", value: fmt(results.stats.p25) },
                { label: "P75", value: fmt(results.stats.p75) },
                { label: "P90", value: fmt(results.stats.p90) },
                { label: "Min", value: fmt(results.stats.min) },
                { label: "Max", value: fmt(results.stats.max) },
              ].map((item) => (
                <Card key={item.label}>
                  <CardContent className="p-3">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{item.label}</p>
                    <p className="text-lg font-semibold mt-0.5">{item.value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        )}

        {hasStats && results.buckets?.length > 0 && (
          <Card className="mb-4">
            <CardContent className="p-6 pt-4">
              <p className="text-sm font-medium text-foreground mb-4">{locale === "zh" ? "分布" : "Distribution"}</p>
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={results.buckets} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="gradBucket" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.2} />
                      <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" opacity={0.5} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={36} />
                  <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }} />
                  <Area type="natural" dataKey="count" stroke="hsl(var(--primary))" fill="url(#gradBucket)" strokeWidth={2} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        {hasStats && results.buckets?.length > 0 && (
          <Card className="mb-4">
            <CardContent className="p-6 pt-4 pb-0">
              <p className="text-sm font-medium text-foreground mb-2">{locale === "zh" ? "分布数据" : "Distribution Data"}</p>
            </CardContent>
            <div className="border-t border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{locale === "zh" ? "区间" : "Bucket"}</TableHead>
                    <TableHead className="text-right w-24">{locale === "zh" ? "数量" : "Count"}</TableHead>
                    <TableHead className="w-48">{locale === "zh" ? "占比" : "Share"}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {results.buckets.map((b: any, i: number) => (
                    <TableRow key={i}>
                      <TableCell className="font-medium">{b.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{Number(b.count).toLocaleString()}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Progress value={typeof b.percentage === "number" ? b.percentage : 0} className="h-1.5 flex-1" />
                          <span className="text-xs text-muted-foreground w-10 text-right tabular-nums">
                            {typeof b.percentage === "number" ? `${b.percentage.toFixed(1)}%` : "—"}
                          </span>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
        )}

        {/* Event results — KPI + time series chart */}
        {hasData && mode !== "user" && eventData.length > 0 && (
          <>
            <div className="grid gap-4 grid-cols-3 mb-4">
              <Card>
                <CardContent className="p-4">
                  <p className="text-xs font-medium text-muted-foreground">{locale === "zh" ? "总计" : "Total"}</p>
                  <p className="text-2xl font-bold tracking-tight mt-1">{results.data.reduce((s: number, d: any) => s + (d.value || 0), 0).toLocaleString()}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <p className="text-xs font-medium text-muted-foreground">{locale === "zh" ? "数据点" : "Data Points"}</p>
                  <p className="text-2xl font-bold tracking-tight mt-1">{eventData.length}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <p className="text-xs font-medium text-muted-foreground">{locale === "zh" ? "峰值" : "Peak"}</p>
                  <p className="text-2xl font-bold tracking-tight mt-1">{Math.max(0, ...results.data.map((d: any) => d.value || 0)).toLocaleString()}</p>
                </CardContent>
              </Card>
            </div>
            <Card className="mb-4">
              <CardContent className="p-6 pt-4">
                <div className="flex items-center justify-end mb-4">
                  <div className="flex items-center gap-0.5 border border-border rounded-md p-0.5 bg-muted/30">
                    {(["line", "bar"] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => setEventChartType(t)}
                        className={`px-3 py-1 text-xs rounded font-medium transition-colors ${eventChartType === t ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                      >
                        {t === "line" ? (locale === "zh" ? "折线" : "Line") : (locale === "zh" ? "柱状" : "Bar")}
                      </button>
                    ))}
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={320}>
                  {eventChartType === "bar" ? (
                    <BarChart data={eventData} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" opacity={0.5} />
                      <XAxis dataKey="period" tickFormatter={formatPeriod} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={40} />
                      <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }} labelFormatter={formatPeriod} />
                      {hasDimension ? (
                        <>
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          {dimensions.map((dim, i) => (
                            <Bar key={dim} dataKey={dim} fill={DIMENSION_COLORS[i % DIMENSION_COLORS.length]} radius={[3, 3, 0, 0]} />
                          ))}
                        </>
                      ) : (
                        <Bar dataKey="value" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                      )}
                    </BarChart>
                  ) : (
                    <LineChart data={eventData} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" opacity={0.5} />
                      <XAxis dataKey="period" tickFormatter={formatPeriod} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={40} />
                      <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }} labelFormatter={formatPeriod} />
                      {hasDimension ? (
                        <>
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          {dimensions.map((dim, i) => {
                            const color = DIMENSION_COLORS[i % DIMENSION_COLORS.length];
                            return (
                              <Line
                                key={dim}
                                type="linear"
                                dataKey={dim}
                                stroke={color}
                                strokeWidth={2}
                                dot={{ r: 3, fill: "#fff", stroke: color, strokeWidth: 2 }}
                                activeDot={{ r: 5, fill: "#fff", stroke: color, strokeWidth: 2 }}
                              />
                            );
                          })}
                        </>
                      ) : (
                        <Line
                          type="linear"
                          dataKey="value"
                          stroke="hsl(var(--primary))"
                          strokeWidth={2.5}
                          dot={{ r: 3, fill: "#fff", stroke: "hsl(var(--primary))", strokeWidth: 2 }}
                          activeDot={{ r: 5, fill: "#fff", stroke: "hsl(var(--primary))", strokeWidth: 2 }}
                        />
                      )}
                    </LineChart>
                  )}
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {results.data?.length > 0 && (() => {
              const hasDim = results.data.some((d: any) => d.dimension != null);
              return (
                <Card className="mb-4">
                  <CardContent className="p-6 pt-4 pb-0">
                    <p className="text-sm font-medium text-foreground mb-2">{locale === "zh" ? "明细数据" : "Data"}</p>
                  </CardContent>
                  <div className="border-t border-border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{locale === "zh" ? "时间" : "Period"}</TableHead>
                          {hasDim && <TableHead>{locale === "zh" ? "维度" : "Dimension"}</TableHead>}
                          <TableHead className="text-right">{locale === "zh" ? "值" : "Value"}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {results.data.map((d: any, i: number) => (
                          <TableRow key={i}>
                            <TableCell className="text-muted-foreground">{formatPeriod(d.period)}</TableCell>
                            {hasDim && <TableCell>{String(d.dimension ?? "—")}</TableCell>}
                            <TableCell className="text-right font-medium tabular-nums">{Number(d.value).toLocaleString()}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </Card>
              );
            })()}
          </>
        )}

        {/* Funnel results */}
        {results && "steps" in results && Array.isArray(results.steps) && results.steps.length > 0 && (() => {
          const steps = results.steps as { step: string; eventType: string; count: number; conversionRate: number; totalRate: number }[];
          const maxCount = steps[0]?.count || 1;
          return (
            <>
              <div className="grid gap-4 grid-cols-2 mb-4">
                <Card><CardContent className="p-4">
                  <p className="text-xs text-muted-foreground">{locale === "zh" ? "第1步用户数" : "Step 1 Users"}</p>
                  <p className="text-2xl font-bold tracking-tight mt-1">{steps[0].count.toLocaleString()}</p>
                </CardContent></Card>
                <Card><CardContent className="p-4">
                  <p className="text-xs text-muted-foreground">{locale === "zh" ? "最终转化率" : "Completion Rate"}</p>
                  <p className="text-2xl font-bold tracking-tight mt-1">{steps[steps.length - 1].totalRate}%</p>
                </CardContent></Card>
              </div>

              <Card className="mb-4">
                <CardContent className="p-6">
                  <p className="text-sm font-medium text-foreground mb-4">{locale === "zh" ? "漏斗" : "Funnel"}</p>
                  <div className="space-y-3">
                    {steps.map((s, i) => (
                      <div key={i} className="flex items-center gap-3">
                        <span className="w-5 h-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center shrink-0 font-medium">{i + 1}</span>
                        <div className="flex-1">
                          <div
                            className="h-8 rounded flex items-center px-3"
                            style={{ width: `${Math.max(maxCount > 0 ? s.count / maxCount * 100 : 0, 8)}%`, backgroundColor: DIMENSION_COLORS[i % DIMENSION_COLORS.length] + "20", borderLeft: `3px solid ${DIMENSION_COLORS[i % DIMENSION_COLORS.length]}` }}
                          >
                            <span className="text-xs font-medium truncate">{s.eventType.replace(".", " → ")}</span>
                          </div>
                        </div>
                        <span className="text-sm font-medium w-16 text-right">{s.count.toLocaleString()}</span>
                        <span className="text-xs text-muted-foreground w-12 text-right">{s.totalRate}%</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <Card className="mb-4">
                <CardContent className="p-0">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b">
                      <th className="text-left px-4 py-2 font-medium text-muted-foreground">#</th>
                      <th className="text-left px-4 py-2 font-medium text-muted-foreground">{locale === "zh" ? "事件" : "Event"}</th>
                      <th className="text-right px-4 py-2 font-medium text-muted-foreground">{locale === "zh" ? "用户数" : "Users"}</th>
                      <th className="text-right px-4 py-2 font-medium text-muted-foreground">{locale === "zh" ? "转化率" : "Conv."}</th>
                      <th className="text-right px-4 py-2 font-medium text-muted-foreground">{locale === "zh" ? "总转化" : "Overall"}</th>
                    </tr></thead>
                    <tbody>
                      {steps.map((s, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="px-4 py-2">{i + 1}</td>
                          <td className="px-4 py-2">{s.eventType}</td>
                          <td className="text-right px-4 py-2 font-medium">{s.count.toLocaleString()}</td>
                          <td className="text-right px-4 py-2 text-muted-foreground">{i === 0 ? "—" : `${s.conversionRate}%`}</td>
                          <td className="text-right px-4 py-2 text-muted-foreground">{s.totalRate}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </>
          );
        })()}

        {/* User results — Pie/Bar chart + table */}
        {hasData && mode === "user" && (() => {
          const data = results.data.filter((d: any) => d.dimension != null);
          const total = data.reduce((s: number, d: any) => s + (d.value || 0), 0);
          const singleValue = !data.length && results.data.length === 1;
          return (
            <>
              {singleValue ? (
                <Card className="mb-4">
                  <CardContent className="p-6 text-center">
                    <p className="text-xs text-muted-foreground">{config.measure === "count" ? (locale === "zh" ? "用户总数" : "Total Users") : config.measureField}</p>
                    <p className="text-4xl font-bold tracking-tight mt-2">{Number(results.data[0].value).toLocaleString()}</p>
                  </CardContent>
                </Card>
              ) : data.length > 0 && (
                <>
                  <div className="grid gap-4 grid-cols-2 mb-4">
                    <Card><CardContent className="p-4">
                      <p className="text-xs text-muted-foreground">{locale === "zh" ? "总计" : "Total"}</p>
                      <p className="text-2xl font-bold tracking-tight mt-1">{total.toLocaleString()}</p>
                    </CardContent></Card>
                    <Card><CardContent className="p-4">
                      <p className="text-xs text-muted-foreground">{locale === "zh" ? "分组数" : "Groups"}</p>
                      <p className="text-2xl font-bold tracking-tight mt-1">{data.length}</p>
                    </CardContent></Card>
                  </div>

                  <Card className="mb-4">
                    <CardContent className="p-6 pt-4">
                      <div className="flex items-center justify-between mb-4">
                        <p className="text-sm font-medium text-foreground">{locale === "zh" ? "分布" : "Distribution"}</p>
                        <div className="flex items-center gap-1 border rounded-md p-0.5">
                          <button onClick={() => setChartType("pie")} className={`px-2 py-1 text-xs rounded ${chartType === "pie" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>◔</button>
                          <button onClick={() => setChartType("bar")} className={`px-2 py-1 text-xs rounded ${chartType === "bar" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>▥</button>
                        </div>
                      </div>
                      {chartType === "pie" ? (
                        <div className="flex items-center gap-8">
                          <ResponsiveContainer width="50%" height={280}>
                            <PieChart>
                              <Pie data={data} dataKey="value" nameKey="dimension" cx="50%" cy="50%" outerRadius={100} innerRadius={50} paddingAngle={2}>
                                {data.map((_: any, i: number) => <Cell key={i} fill={DIMENSION_COLORS[i % DIMENSION_COLORS.length]} />)}
                              </Pie>
                              <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                            </PieChart>
                          </ResponsiveContainer>
                          <div className="flex-1 space-y-2">
                            {data.map((d: any, i: number) => (
                              <div key={i} className="flex items-center gap-2 text-sm">
                                <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: DIMENSION_COLORS[i % DIMENSION_COLORS.length] }} />
                                <span className="flex-1 truncate text-foreground">{String(d.dimension ?? "null")}</span>
                                <span className="text-muted-foreground">{total ? `${Math.round(d.value / total * 100)}%` : "0%"}</span>
                                <span className="font-medium w-16 text-right">{Number(d.value).toLocaleString()}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <ResponsiveContainer width="100%" height={280}>
                          <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" opacity={0.5} />
                            <XAxis dataKey="dimension" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
                            <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={40} />
                            <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                              {data.map((_: any, i: number) => <Cell key={i} fill={DIMENSION_COLORS[i % DIMENSION_COLORS.length]} />)}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      )}
                    </CardContent>
                  </Card>

                  <Card className="mb-4">
                    <CardContent className="p-0">
                      <table className="w-full text-sm">
                        <thead><tr className="border-b">
                          <th className="text-left px-4 py-2 font-medium text-muted-foreground">{locale === "zh" ? "维度" : "Dimension"}</th>
                          <th className="text-right px-4 py-2 font-medium text-muted-foreground">{locale === "zh" ? "值" : "Value"}</th>
                          <th className="text-right px-4 py-2 font-medium text-muted-foreground">%</th>
                        </tr></thead>
                        <tbody>
                          {data.map((d: any, i: number) => (
                            <tr key={i} className="border-b last:border-0">
                              <td className="px-4 py-2 flex items-center gap-2">
                                <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: DIMENSION_COLORS[i % DIMENSION_COLORS.length] }} />
                                {String(d.dimension ?? "null")}
                              </td>
                              <td className="text-right px-4 py-2">{Number(d.value).toLocaleString()}</td>
                              <td className="text-right px-4 py-2 text-muted-foreground">{total ? `${Math.round(d.value / total * 100)}%` : "0%"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </CardContent>
                  </Card>
                </>
              )}
            </>
          );
        })()}

      </div>
    </div>
  );
}

function fmt(seconds: number): string {
  if (!seconds) return "0s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function inferTimeRange(startDate: string): string {
  if (!startDate) return "7";
  const days = Math.round((Date.now() - new Date(startDate).getTime()) / 86400000);
  if (days <= 7) return "7";
  if (days <= 14) return "14";
  if (days <= 30) return "30";
  if (days <= 90) return "90";
  if (days <= 180) return "180";
  return "360";
}
