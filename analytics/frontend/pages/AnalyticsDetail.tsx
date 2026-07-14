import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ResponsiveContainer, LineChart as ReLineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, PieChart as RePieChart, Pie, Cell, BarChart as ReBarChart, Bar, Legend } from "recharts";
import { LineChart, BarChart3, PieChart } from "lucide-react";
import { createReport, getReport, updateReport, recomputeReport, listDashboards, createDashboard, addDashboardItem, type Dashboard } from "../lib/api";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";
import { ReportConfig, type ReportConfigValues } from "../components/ReportConfig";
import { IntervalDistributionChart } from "../components/IntervalDistributionChart";
import { fillTimeSeries, generatePeriodKeys, normalizeDate } from "../lib/fill-time-series";
import { fillIntervalPeriods } from "../lib/fill-interval-periods";
import { fmtDuration } from "../lib/format";
import { Button } from "../../../shared/frontend/ui/button";
import { Input } from "../../../shared/frontend/ui/input";
import { Card, CardContent } from "../../../shared/frontend/ui/card";
import { Tooltip as UiTooltip, TooltipTrigger as UiTooltipTrigger, TooltipContent as UiTooltipContent, TooltipProvider as UiTooltipProvider } from "../../../shared/frontend/ui/tooltip";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../../../shared/frontend/ui/dropdown-menu";
import { DIMENSION_COLORS } from "../../../shared/frontend/lib/colors";
import { ResultsTable } from "../../../shared/frontend/components/ResultsTable";
import { ChartTypeToggle } from "../../../shared/frontend/components/ChartTypeToggle";
import { formatPeriod as sharedFormatPeriod } from "../lib/format-period";

const MODE_TITLES: Record<string, { en: string; zh: string }> = {
  event: { en: "Event Analysis", zh: "事件分析" },
  interval: { en: "Interval Analysis", zh: "间隔分析" },
  user: { en: "User Analysis", zh: "用户分析" },
  content: { en: "Content Analysis", zh: "内容分析" },
  funnel: { en: "Funnel Analysis", zh: "漏斗分析" },
};

const UI = {
  en: {
    saved: "Saved",
    saveFailed: "Save failed",
    recomputeQueued: "Recompute queued",
    recomputeFailed: "Recompute failed",
    notComputedYet: "Not computed yet",
    recomputing: "Recomputing...",
    recompute: "Re-compute",
    dataUpdated: "Data updated: ",
    dashboardNamePrompt: "Dashboard name",
    addedTo: "Added to",
    newDashboard: "New Dashboard",
    saving: "Saving...",
    save: "Save",
    computing: "Computing...",
    distribution: "Distribution",
    distributionData: "Distribution Data",
    period: "Period",
    count: "Count",
    min: "Min",
    median: "Median",
    max: "Max",
    line: "Line",
    bar: "Bar",
    pieChart: "Pie",
    data: "Data",
    dimension: "Dimension",
    value: "Value",
    step1Users: "Step 1 Users",
    completionRate: "Completion Rate",
    funnel: "Funnel",
    event: "Event",
    users: "Users",
    conv: "Conv.",
    overall: "Overall",
    totalUsers: "Total Users",
    totalContent: "Total Content",
  },
  zh: {
    saved: "已保存",
    saveFailed: "保存失败",
    recomputeQueued: "已重新计算",
    recomputeFailed: "重新计算失败",
    notComputedYet: "尚未计算",
    recomputing: "计算中...",
    recompute: "重新计算",
    dataUpdated: "数据更新时间：",
    dashboardNamePrompt: "输入仪表盘名称",
    addedTo: "已添加到",
    newDashboard: "新建仪表盘",
    saving: "保存中...",
    save: "Save",
    computing: "查询中...",
    distribution: "分布",
    distributionData: "分布数据",
    period: "时间",
    count: "配对数",
    min: "最小值",
    median: "中位数",
    max: "最大值",
    line: "折线",
    bar: "柱状",
    pieChart: "饼图",
    data: "明细数据",
    dimension: "维度",
    value: "值",
    step1Users: "第1步用户数",
    completionRate: "最终转化率",
    funnel: "漏斗",
    event: "事件",
    users: "用户数",
    conv: "转化率",
    overall: "总转化",
    totalUsers: "用户总数",
    totalContent: "内容总数",
  },
} as const;

export function AnalyticsDetail({ mode: modeProp }: { mode?: "event" | "interval" | "user" | "content" | "funnel" }) {
  const { id: paramId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { locale, timezone } = useLocale();
  const { toast } = useToast();
  const t = UI[locale as "en" | "zh"];

  const [mode, setMode] = useState<"event" | "interval" | "user" | "content" | "funnel">(modeProp || "event");
  const [name, setName] = useState(() => (paramId ? "" : `Untitled ${MODE_TITLES[mode]?.en || "Analysis"}`));
  // Unified chart-type preference, persisted to report params as `chart_type`
  // for every mode (event: line/bar, user: pie/bar, interval: boxplot only —
  // no user-facing toggle yet, funnel: unused). Editing this never triggers
  // recomputation (see backend PATCH diff logic).
  const [chartType, setChartType] = useState<string>(() => {
    const m = modeProp || "event";
    return m === "user" || m === "content" ? "pie" : m === "interval" ? "boxplot" : "line";
  });
  const [config, setConfig] = useState<ReportConfigValues>({
    mode,
    eventType: "",
    measure: "count",
    eventTypeA: "",
    eventTypeB: "",
    dimension: "",
    sortColumn: "dimension",
    sortDirection: "asc",
    timeRange: "7",
    granularity: "day",
  });

  const [reportId, setReportId] = useState<string | null>(paramId || null);
  // Tracked separately from state so `runQuery` can read the latest value
  // without needing `reportId` in its own dependency array (which would
  // otherwise cause it to re-fire immediately after every creation).
  const reportIdRef = useRef<string | null>(paramId || null);
  useEffect(() => { reportIdRef.current = reportId; }, [reportId]);
  // Same idea for `name`: it must never be part of runQuery's own deps
  // (editing the display name must never re-trigger computation), but the
  // very first auto-created draft should still start with a sensible name.
  const nameRef = useRef(name);
  useEffect(() => { nameRef.current = name; }, [name]);
  const [results, setResults] = useState<any>(null);
  const [loading, setLoading] = useState(!!paramId);
  const [error, setError] = useState("");
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [dashDropOpen, setDashDropOpen] = useState(false);
  const [initialized, setInitialized] = useState(!paramId);
  const [saving, setSaving] = useState(false);
  const [computedAt, setComputedAt] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);

  const title = MODE_TITLES[mode]?.[locale] || MODE_TITLES[mode]?.en || mode;
  useEffect(() => { document.title = `${title} — UniSCRM`; }, [title]);

  // Load existing report if navigated with :id
  useEffect(() => {
    if (!paramId) return;
    getReport(paramId).then((d) => {
      const r = d.report;
      setReportId(r.id);
      const resolvedMode = (r.type as any) || "event";
      setMode(resolvedMode);
      setName(r.name || `${r.type} #${r.id.slice(0, 8)}`);
      const p = r.params as any;
      setConfig({
        mode: resolvedMode,
        eventType: p.event_type || "",
        measure: p.measure || "count",
        measureField: p.measure_field || undefined,
        eventTypeA: p.event_type_a || "",
        eventTypeB: p.event_type_b || "",
        dimension: p.dimension || "",
        dimensionBucketMode: p.dimension_bucket_mode || (Array.isArray(p.buckets) && p.buckets.length > 0 ? "custom" : "discrete"),
        buckets: Array.isArray(p.buckets) ? p.buckets.join(",") : (p.buckets || ""),
        sortColumn: p.sort_column || "dimension",
        sortDirection: (p.sort_direction === "desc" ? "desc" : "asc"),
        timeRange: typeof p.time_range === "string" && p.time_range ? p.time_range : inferTimeRange(p.time_range_start || ""),
        granularity: p.granularity || "day",
        compareEnabled: !!p.compare_enabled,
        compareTimeRange: p.compare_time_range || "7",
        filters: p.filters,
        funnelSteps: Array.isArray(p.steps) ? p.steps : undefined,
        windowValue: p.window_value || undefined,
        windowUnit: p.window_unit || undefined,
      });
      if (typeof p.chart_type === "string") {
        setChartType(p.chart_type);
      } else {
        setChartType(resolvedMode === "user" || resolvedMode === "content" ? "pie" : resolvedMode === "interval" ? "boxplot" : "line");
      }
      if (r.results) setResults(r.results);
      setComputedAt(r.computed_at || null);
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
      };
    }
    if (mode === "user" || mode === "content") {
      const buckets = config.buckets ? config.buckets.split(",").map(Number).filter(n => !isNaN(n) && n > 0) : undefined;
      return {
        measure: config.measure,
        measure_field: config.measureField || undefined,
        dimension: config.dimension || undefined,
        dimension_bucket_mode: config.dimensionBucketMode || undefined,
        buckets: buckets?.length ? buckets : undefined,
        filters: config.filters,
        chart_type: chartType,
        sort_column: config.sortColumn || "dimension",
        sort_direction: config.sortDirection || "asc",
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
        chart_type: chartType,
      };
    }

    const buckets = config.buckets ? config.buckets.split(",").map(Number).filter(n => !isNaN(n) && n > 0) : undefined;
    return {
      event_type: config.eventType,
      measure: config.measure,
      dimension: config.dimension || undefined,
      dimension_bucket_mode: config.dimensionBucketMode || undefined,
      buckets: buckets?.length ? buckets : undefined,
      granularity: config.granularity,
      time_range: config.timeRange,
      time_range_start: start,
      compare_enabled: !!config.compareEnabled,
      compare_time_range: config.compareTimeRange || undefined,
      filters: config.filters,
      chart_type: chartType,
      sort_column: config.sortColumn || "dimension",
      sort_direction: config.sortDirection || "asc",
    };
  }, [config, mode, chartType]);

  // Increments every time runQuery (re)triggers computation on the *same*
  // reportId (i.e. an update, not a fresh creation), so the polling effect
  // below restarts even though `reportId` itself didn't change.
  const [pollNonce, setPollNonce] = useState(0);

  const runQuery = useCallback(async () => {
    if (mode === "interval" && (!config.eventTypeA || !config.eventTypeB)) return;
    if (mode === "event" && !config.eventType) return;
    if (mode === "funnel" && (!config.funnelSteps || config.funnelSteps.filter(Boolean).length < 2)) return;
    setLoading(true);
    setError("");
    setResults(null);

    try {
      const params = buildReportParams();
      // Only create a new report row the first time; every subsequent config
      // change while still drafting a new (unsaved) report must update that
      // same row instead of creating another one — otherwise every dropdown
      // edit before the user clicks Save leaves behind an orphaned duplicate
      // report.
      if (reportIdRef.current) {
        await updateReport(reportIdRef.current, { type: mode, params });
        setPollNonce((n) => n + 1);
      } else {
        const res = await createReport({ name: nameRef.current.trim() || undefined, type: mode, params });
        setReportId(res.report.id);
      }
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
          setComputedAt(res.report.computed_at || null);
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
  }, [reportId, pollNonce]);

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
      toast({ description: t.saved });
      navigate("/analytics");
    } catch (err) {
      const message = err instanceof Error ? err.message : t.saveFailed;
      toast({ variant: "destructive", description: message });
    } finally {
      setSaving(false);
    }
  };

  const handleRecompute = async () => {
    if (!reportId) return;
    setRecomputing(true);
    try {
      await recomputeReport(reportId);
      setLoading(true);
      setPollNonce((n) => n + 1);
      toast({ description: t.recomputeQueued });
    } catch (err) {
      const message = err instanceof Error ? err.message : t.recomputeFailed;
      toast({ variant: "destructive", description: message });
    } finally {
      setRecomputing(false);
    }
  };

  const formatComputedAt = (iso: string | null) => {
    if (!iso) return t.notComputedYet;
    const d = new Date(iso.includes("T") || iso.endsWith("Z") ? iso : `${iso.replace(" ", "T")}Z`);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  };

  const formatPeriod = (p: unknown) => sharedFormatPeriod(p, config.granularity, locale, timezone);

  // ResultsTable is controlled: sort state lives here (not inside
  // ResultsTable) so both the chart above a results table and the table
  // itself can reorder from the same resolved order. Persisted into
  // config like chart_type, restored on load, PATCHed on Save.
  const sortColumn = config.sortColumn || "dimension";
  const sortDirection = config.sortDirection || "asc";
  const handleSortChange = (key: string, dir: "asc" | "desc") => {
    setConfig((prev) => ({ ...prev, sortColumn: key, sortDirection: dir }));
  };

  const hasStats = results && "periods" in results;
  const intervalSlots = hasStats ? fillIntervalPeriods(results.periods, config.timeRange, config.granularity) : [];
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
          const key = normalizeDate(String(d.period || ""));
          if (!byPeriod.has(key)) byPeriod.set(key, { period: key });
          (byPeriod.get(key) as Record<string, any>)[String(d.dimension ?? "null")] = d.value || 0;
        }
        // Zero-fill periods with no data at all for any dimension, matching
        // the same complete period axis fillTimeSeries produces for the
        // non-dimension case — otherwise the chart/table silently drop
        // periods where every dimension happened to be zero.
        const keys = generatePeriodKeys(config.timeRange, config.granularity);
        if (keys) {
          for (const key of keys) {
            if (!byPeriod.has(key)) byPeriod.set(key, { period: key });
          }
        }
        // Every period row must carry every dimension key (0 default) so
        // lines/bars render continuously and the table always lists the
        // full dimension set per period.
        for (const row of byPeriod.values()) {
          for (const dim of dimensions) {
            if (!(dim in row)) row[dim] = 0;
          }
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
        <UiTooltipProvider>
          <UiTooltip>
            <UiTooltipTrigger asChild>
              <Button variant="outline" size="sm" disabled={!reportId || recomputing} onClick={handleRecompute}>
                {recomputing ? t.recomputing : t.recompute}
              </Button>
            </UiTooltipTrigger>
            <UiTooltipContent>
              {t.dataUpdated}{formatComputedAt(computedAt)}
            </UiTooltipContent>
          </UiTooltip>
        </UiTooltipProvider>
        <DropdownMenu open={dashDropOpen} onOpenChange={setDashDropOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={!reportId}>Add to Dashboard</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={async () => {
              const name = prompt(t.dashboardNamePrompt);
              if (!name || !reportId) return;
              const res = await createDashboard(name);
              await addDashboardItem(res.dashboard.id, reportId);
              setDashboards((prev) => [{ id: res.dashboard.id, name, created_at: "", updated_at: "" }, ...prev]);
              toast({ description: `${t.addedTo} ${name}` });
            }}>
              <span className="text-primary font-medium">+ {t.newDashboard}</span>
            </DropdownMenuItem>
            {dashboards.map((d) => (
              <DropdownMenuItem key={d.id} onClick={async () => {
                if (!reportId) return;
                await addDashboardItem(d.id, reportId);
                toast({ description: `${t.addedTo} ${d.name}` });
              }}>
                {d.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" onClick={handleSave} disabled={saving || !reportId}>
          {saving ? t.saving : t.save}
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <ReportConfig values={config} onChange={setConfig} mode={mode} />

        {loading && (
          <div className="flex items-center justify-center py-16">
            <div className="flex items-center gap-3 text-muted-foreground">
              <div className="h-4 w-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="text-sm">{t.computing}</span>
            </div>
          </div>
        )}
        {error && (
          <Card className="border-destructive/50 bg-destructive/5 mb-4">
            <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
          </Card>
        )}

        {/* Interval results — per-period box plot + matching table */}
        {hasStats && (
          <>
            <Card className="mb-4">
              <CardContent className="p-6 pt-4">
                <p className="text-sm font-medium text-foreground mb-4">{t.distribution}</p>
                <IntervalDistributionChart slots={intervalSlots} locale={locale} tickFormatter={formatPeriod} />
              </CardContent>
            </Card>

            <ResultsTable
              title={t.distributionData}
              columns={[
                { key: "period", label: t.period, render: (s: any) => <span className="text-muted-foreground">{formatPeriod(s.period)}</span> },
                { key: "count", label: t.count, align: "right", render: (s: any) => s.stats ? s.stats.count.toLocaleString() : "—" },
                { key: "min", label: t.min, align: "right", render: (s: any) => s.stats ? fmtDuration(s.stats.min) : "—" },
                { key: "p25", label: "P25", align: "right", render: (s: any) => s.stats ? fmtDuration(s.stats.p25) : "—" },
                { key: "median", label: t.median, align: "right", render: (s: any) => <span className="font-medium">{s.stats ? fmtDuration(s.stats.median) : "—"}</span> },
                { key: "p75", label: "P75", align: "right", render: (s: any) => s.stats ? fmtDuration(s.stats.p75) : "—" },
                { key: "max", label: t.max, align: "right", render: (s: any) => s.stats ? fmtDuration(s.stats.max) : "—" },
              ]}
              rows={intervalSlots as unknown as Record<string, unknown>[]}
            />
          </>
        )}

        {/* Event results — time series chart */}
        {hasData && mode !== "user" && mode !== "content" && eventData.length > 0 && (
          <>
            <Card className="mb-4">
              <CardContent className="p-6 pt-4">
                <div className="flex items-center justify-end mb-4">
                  <ChartTypeToggle
                    value={chartType}
                    onChange={setChartType}
                    options={[
                      { value: "line", icon: LineChart, tooltip: t.line },
                      { value: "bar", icon: BarChart3, tooltip: t.bar },
                    ]}
                  />
                </div>
                <ResponsiveContainer width="100%" height={320}>
                  {chartType === "bar" ? (
                    <ReBarChart data={eventData} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" opacity={0.5} />
                      <XAxis dataKey="period" tickFormatter={formatPeriod} tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} width={40} />
                      <Tooltip contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }} labelFormatter={formatPeriod} />
                      {hasDimension ? (
                        <>
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          {dimensions.map((dim, i) => (
                            <Bar key={dim} dataKey={dim} fill={DIMENSION_COLORS[i % DIMENSION_COLORS.length]} radius={[3, 3, 0, 0]} />
                          ))}
                        </>
                      ) : (
                        <Bar dataKey="value" fill="var(--color-primary)" radius={[3, 3, 0, 0]} />
                      )}
                    </ReBarChart>
                  ) : (
                    <ReLineChart data={eventData} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" opacity={0.5} />
                      <XAxis dataKey="period" tickFormatter={formatPeriod} tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} width={40} />
                      <Tooltip contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }} labelFormatter={formatPeriod} />
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
                          stroke="var(--color-primary)"
                          strokeWidth={2.5}
                          dot={{ r: 3, fill: "#fff", stroke: "var(--color-primary)", strokeWidth: 2 }}
                          activeDot={{ r: 5, fill: "#fff", stroke: "var(--color-primary)", strokeWidth: 2 }}
                        />
                      )}
                    </ReLineChart>
                  )}
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {eventData.length > 0 && (() => {
              const tableRows: { period: string; dimension?: string; value: number }[] = hasDimension
                ? eventData.flatMap((row: any) => dimensions.map((dim) => ({ period: row.period, dimension: dim, value: Number(row[dim]) || 0 })))
                : eventData.map((d: any) => ({ period: d.period, value: Number(d.value) || 0 }));
              return (
                <ResultsTable
                  title={t.data}
                  columns={[
                    { key: "period", label: t.period, render: (d: any) => <span className="text-muted-foreground">{formatPeriod(d.period)}</span> },
                    ...(hasDimension ? [{ key: "dimension", label: t.dimension, render: (d: any) => String(d.dimension ?? "—") }] : []),
                    { key: "value", label: t.value, align: "right" as const, render: (d: any) => <span className="font-medium">{d.value.toLocaleString()}</span> },
                  ]}
                  rows={tableRows}
                />
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
                  <p className="text-xs text-muted-foreground">{t.step1Users}</p>
                  <p className="text-2xl font-bold tracking-tight mt-1">{steps[0].count.toLocaleString()}</p>
                </CardContent></Card>
                <Card><CardContent className="p-4">
                  <p className="text-xs text-muted-foreground">{t.completionRate}</p>
                  <p className="text-2xl font-bold tracking-tight mt-1">{steps[steps.length - 1].totalRate}%</p>
                </CardContent></Card>
              </div>

              <Card className="mb-4">
                <CardContent className="p-6">
                  <p className="text-sm font-medium text-foreground mb-4">{t.funnel}</p>
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

              <ResultsTable
                title={t.data}
                columns={[
                  { key: "idx", label: "#", render: (s: any) => s.idx },
                  { key: "eventType", label: t.event, render: (s: any) => s.eventType },
                  { key: "count", label: t.users, align: "right", render: (s: any) => <span className="font-medium">{s.count.toLocaleString()}</span> },
                  { key: "conversionRate", label: t.conv, align: "right", render: (s: any) => <span className="text-muted-foreground">{s.idx === 1 ? "—" : `${s.conversionRate}%`}</span> },
                  { key: "totalRate", label: t.overall, align: "right", render: (s: any) => <span className="text-muted-foreground">{s.totalRate}%</span> },
                ]}
                rows={steps.map((s, i) => ({ ...s, idx: i + 1 }))}
              />
            </>
          );
        })()}

        {/* User/Content results — Pie/Bar chart + table (no dimension selected collapses to a single "Total" slice, same code path) */}
        {hasData && (mode === "user" || mode === "content") && (() => {
          const dimensioned = results.data.filter((d: any) => d.dimension != null);
          const totalLabel = mode === "content" ? t.totalContent : t.totalUsers;
          const data = dimensioned.length > 0
            ? dimensioned
            : results.data.length === 1
              ? [{ dimension: config.measure === "count" ? totalLabel : (config.measureField || t.value), value: results.data[0].value }]
              : [];
          const total = data.reduce((s: number, d: any) => s + (d.value || 0), 0);
          if (data.length === 0) return null;
          return (
            <>
              <Card className="mb-4">
                <CardContent className="p-6 pt-4">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-sm font-medium text-foreground">{t.distribution}</p>
                    <ChartTypeToggle
                      value={chartType}
                      onChange={setChartType}
                      options={[
                        { value: "pie", icon: PieChart, tooltip: t.pieChart },
                        { value: "bar", icon: BarChart3, tooltip: t.bar },
                      ]}
                    />
                  </div>
                  {chartType === "pie" ? (
                    <div className="flex items-center gap-8">
                      <ResponsiveContainer width="50%" height={280}>
                        <RePieChart>
                          <Pie data={data} dataKey="value" nameKey="dimension" cx="50%" cy="50%" outerRadius={100} innerRadius={50} paddingAngle={2}>
                            {data.map((_: any, i: number) => <Cell key={i} fill={DIMENSION_COLORS[i % DIMENSION_COLORS.length]} />)}
                          </Pie>
                          <Tooltip contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }} />
                        </RePieChart>
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
                      <ReBarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" opacity={0.5} />
                        <XAxis dataKey="dimension" tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} />
                        <YAxis tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} width={40} />
                        <Tooltip contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }} />
                        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                          {data.map((_: any, i: number) => <Cell key={i} fill={DIMENSION_COLORS[i % DIMENSION_COLORS.length]} />)}
                        </Bar>
                      </ReBarChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              <ResultsTable
                title={t.data}
                columns={[
                  {
                    key: "dimension", label: t.dimension, render: (d: any) => {
                      const i = data.indexOf(d);
                      return (
                        <span className="flex items-center gap-2">
                          <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: DIMENSION_COLORS[i % DIMENSION_COLORS.length] }} />
                          {String(d.dimension ?? "null")}
                        </span>
                      );
                    },
                  },
                  { key: "value", label: t.value, align: "right", render: (d: any) => Number(d.value).toLocaleString() },
                  { key: "pct", label: "%", align: "right", render: (d: any) => <span className="text-muted-foreground">{total ? `${Math.round(d.value / total * 100)}%` : "0%"}</span> },
                ]}
                rows={data}
              />
            </>
          );
        })()}

      </div>
    </div>
  );
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
