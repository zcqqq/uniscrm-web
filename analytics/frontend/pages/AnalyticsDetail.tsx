import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ResponsiveContainer, LineChart as ReLineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, PieChart as RePieChart, Pie, Cell, BarChart as ReBarChart, Bar, Legend } from "recharts";
import { LineChart, BarChart3, PieChart } from "lucide-react";
import { createReport, getReport, updateReport, recomputeReport, listDashboards, createDashboard, addDashboardItem, type Dashboard } from "../lib/api";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";
import { useT } from "../../../shared/frontend/hooks/useT";
import { C } from "../../../shared/frontend/i18n-common";
import type { LocalizedString } from "../../../metadata/dataTypes";
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
import { DateCell } from "../../../shared/frontend/components/CellDate";
import { compareRows } from "../../../shared/frontend/components/DataTable";
import { PROPS } from "../../../metadata/props";
import { ChartTypeToggle } from "../../../shared/frontend/components/ChartTypeToggle";
import { formatPeriod as sharedFormatPeriod } from "../lib/format-period";
import { formatCompactDate, formatCompactWeekRange } from "../lib/format-compact-date";

const MODE_TITLES: Record<string, { en: string; zh: string }> = {
  event: { en: "Event Analytics", zh: "事件分析" },
  interval: { en: "Interval Analytics", zh: "间隔分析" },
  user: { en: "User Analytics", zh: "用户分析" },
  content: { en: "Content Analytics", zh: "内容分析" },
  funnel: { en: "Funnel Analytics", zh: "漏斗分析" },
};

const UI = {
  saved: { en: "Saved", zh: "已保存" },
  saveFailed: { en: "Save failed", zh: "保存失败" },
  recomputeQueued: { en: "Recompute queued", zh: "已重新计算" },
  recomputeFailed: { en: "Recompute failed", zh: "重新计算失败" },
  notComputedYet: { en: "Not computed yet", zh: "尚未计算" },
  recomputing: { en: "Recomputing...", zh: "计算中…" },
  recompute: { en: "Re-compute", zh: "重新计算" },
  dataUpdated: { en: "Data updated: ", zh: "数据更新时间：" },
  dashboardNamePrompt: { en: "Dashboard name", zh: "输入仪表盘名称" },
  addedTo: { en: "Added to", zh: "已添加到" },
  newDashboard: { en: "New Dashboard", zh: "新建仪表盘" },
  saving: { en: "Saving...", zh: "保存中…" },
  save: { en: "Save", zh: "保存" },
  computing: { en: "Computing...", zh: "查询中…" },
  distribution: { en: "Distribution", zh: "分布" },
  distributionData: { en: "Distribution Data", zh: "分布数据" },
  period: { en: "Period", zh: "时间" },
  count: { en: "Count", zh: "配对数" },
  min: { en: "Min", zh: "最小值" },
  median: { en: "Median", zh: "中位数" },
  max: { en: "Max", zh: "最大值" },
  line: { en: "Line", zh: "折线" },
  bar: { en: "Bar", zh: "柱状" },
  pieChart: { en: "Pie", zh: "饼图" },
  data: { en: "Data", zh: "明细数据" },
  dimension: { en: "Dimension", zh: "维度" },
  value: { en: "Value", zh: "值" },
  step1Users: { en: "Step 1 Users", zh: "第1步用户数" },
  completionRate: { en: "Completion Rate", zh: "最终转化率" },
  funnel: { en: "Funnel", zh: "漏斗" },
  event: { en: "Event", zh: "事件" },
  users: { en: "Users", zh: "用户数" },
  conv: { en: "Conv.", zh: "转化率" },
  overall: { en: "Overall", zh: "总转化" },
  totalUsers: { en: "Total Users", zh: "用户总数" },
  totalContent: { en: "Total Content", zh: "内容总数" },
  error: { en: "Error", zh: "错误" },
  failed: { en: "Failed", zh: "失败" },
  queryFailed: { en: "Query failed", zh: "查询失败" },
} satisfies Record<string, LocalizedString>;

export function AnalyticsDetail({ mode: modeProp }: { mode?: "event" | "interval" | "user" | "content" | "funnel" }) {
  const { id: paramId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { locale, timezone } = useLocale();
  const { toast } = useToast();
  const T = useT();

  const [mode, setMode] = useState<"event" | "interval" | "user" | "content" | "funnel">(modeProp || "event");
  const [name, setName] = useState(() => (paramId ? "" : `${T({ en: "Untitled", zh: "未命名" })} ${MODE_TITLES[mode] ? T(MODE_TITLES[mode]) : T({ en: "Analytics", zh: "分析" })}`));
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
        dimensionDateGranularity: p.dimension_date_granularity || undefined,
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
      if (r.status === "error") setError(r.error_message || T(UI.error));
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
        dimension_date_granularity: config.dimensionDateGranularity || undefined,
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
      dimension_date_granularity: config.dimensionDateGranularity || undefined,
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
      setError(err instanceof Error ? err.message : T(UI.failed));
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
          // A recompute that succeeds must retire the previous run's error banner —
          // otherwise a fixed report keeps showing the old failure next to fresh data.
          setError("");
          setResults(res.report.results);
          setComputedAt(res.report.computed_at || null);
          setLoading(false);
          clearInterval(poll);
        } else if (res.report.status === "error") {
          setError(res.report.error_message || T(UI.queryFailed));
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
      toast({ description: T(UI.saved) });
      navigate("/analytics");
    } catch (err) {
      const message = err instanceof Error ? err.message : T(UI.saveFailed);
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
      toast({ description: T(UI.recomputeQueued) });
    } catch (err) {
      const message = err instanceof Error ? err.message : T(UI.recomputeFailed);
      toast({ variant: "destructive", description: message });
    } finally {
      setRecomputing(false);
    }
  };

  const formatPeriod = (p: unknown) => sharedFormatPeriod(p, config.granularity, timezone);

  // ResultsTable is controlled: sort state lives here (not inside
  // ResultsTable) so both the chart above a results table and the table
  // itself can reorder from the same resolved order. Persisted into
  // config like chart_type, restored on load, PATCHed on Save.
  const sortColumn = config.sortColumn || "dimension";
  const sortDirection = config.sortDirection || "asc";
  const handleSortChange = (key: string, dir: "asc" | "desc") => {
    setConfig((prev) => ({ ...prev, sortColumn: key, sortDirection: dir }));
  };

  // Only INT/DATETIME dimensions get a numeric/chronological sort on the
  // "Dimension" column (bucketed INT range-strings like "100-1000" still
  // count as INT here — Task 1's compareRows extracts their lower bound).
  // Everything else (TEXT/ENUM_TEXT/ENUM_INT) falls through to compareRows'
  // plain string-compare branch by leaving sortType undefined.
  const dimensionPropDef = PROPS.find((p) => p.propId === config.dimension);
  const dimensionSortType: "number" | "date" | undefined =
    dimensionPropDef?.dataType === "DATETIME" ? "date" : dimensionPropDef?.dataType === "INT" ? "number" : undefined;

  // Formats a DATETIME dimension's raw/DATE_TRUNC'd value into the shared
  // non-locale-dependent compact format; every other dataType (TEXT,
  // ENUM_*, INT discrete/bucketed) passes through unchanged, since only
  // DATETIME values ever arrive as ISO timestamps needing this treatment.
  const formatDimensionValue = (v: string): string => {
    if (dimensionPropDef?.dataType !== "DATETIME") return v;
    const gran = config.dimensionDateGranularity || "none";
    return gran === "week" ? formatCompactWeekRange(v, timezone) : formatCompactDate(v, gran, timezone);
  };

  const hasStats = results && "periods" in results;
  const intervalSlots = hasStats ? fillIntervalPeriods(results.periods, config.timeRange, config.granularity) : [];
  const hasData = results && "data" in results;
  const chartData = hasData ? fillTimeSeries(results.data, config.timeRange, config.granularity) : [];
  const hasDimension = hasData && results.data?.some((d: any) => d.dimension != null);
  const dimensions: string[] = hasDimension
    ? Array.from(new Set(results.data.map((d: any) => String(d.dimension ?? "null"))))
    : [];
  // The chart's legend/series order (and DIMENSION_COLORS index assignment)
  // follows the user's sort choice only when sorting by "Dimension" itself —
  // "Value"/"Period" sorts have no single well-defined per-dimension order
  // to reorder the legend by (a dimension's value varies per period), so
  // for those the legend keeps its natural (first-seen) order while the
  // flattened table below still sorts by whichever column was chosen.
  const sortedDimensions = sortColumn === "dimension"
    ? [...dimensions].sort((a, b) => compareRows({ dimension: a }, { dimension: b }, "dimension", dimensionSortType, sortDirection))
    : dimensions;
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
        <Button variant="ghost" size="sm" onClick={() => navigate("/analytics")}>{T({ en: "← Back", zh: "← 返回" })}</Button>
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
                {recomputing ? T(UI.recomputing) : T(UI.recompute)}
              </Button>
            </UiTooltipTrigger>
            <UiTooltipContent>
              <div>{T(UI.dataUpdated)}</div>
              {computedAt ? <DateCell iso={computedAt} timezone={timezone} /> : T(UI.notComputedYet)}
            </UiTooltipContent>
          </UiTooltip>
        </UiTooltipProvider>
        <DropdownMenu open={dashDropOpen} onOpenChange={setDashDropOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={!reportId}>{T({ en: "Add to Dashboard", zh: "添加到仪表盘" })}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={async () => {
              const name = prompt(T(UI.dashboardNamePrompt));
              if (!name || !reportId) return;
              const res = await createDashboard(name);
              await addDashboardItem(res.dashboard.id, reportId);
              setDashboards((prev) => [{ id: res.dashboard.id, name, created_at: "", updated_at: "" }, ...prev]);
              toast({ description: `${T(UI.addedTo)} ${name}` });
            }}>
              <span className="text-primary font-medium">+ {T(UI.newDashboard)}</span>
            </DropdownMenuItem>
            {dashboards.map((d) => (
              <DropdownMenuItem key={d.id} onClick={async () => {
                if (!reportId) return;
                await addDashboardItem(d.id, reportId);
                toast({ description: `${T(UI.addedTo)} ${d.name}` });
              }}>
                {d.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" onClick={handleSave} disabled={saving || !reportId}>
          {saving ? T(UI.saving) : T(UI.save)}
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <ReportConfig values={config} onChange={setConfig} mode={mode} />

        {loading && (
          <div className="flex items-center justify-center py-16">
            <div className="flex items-center gap-3 text-muted-foreground">
              <div className="h-4 w-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="text-sm">{T(UI.computing)}</span>
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
                <p className="text-sm font-medium text-foreground mb-4">{T(UI.distribution)}</p>
                <IntervalDistributionChart slots={intervalSlots} locale={locale} tickFormatter={formatPeriod} />
              </CardContent>
            </Card>

            <ResultsTable
              title={T(UI.distributionData)}
              columns={[
                { key: "period", label: T(UI.period), render: (s: any) => <span className="text-muted-foreground">{formatPeriod(s.period)}</span> },
                { key: "count", label: T(UI.count), align: "right", render: (s: any) => s.stats ? s.stats.count.toLocaleString() : "—" },
                { key: "min", label: T(UI.min), align: "right", render: (s: any) => s.stats ? fmtDuration(s.stats.min) : "—" },
                { key: "p25", label: "P25", align: "right", render: (s: any) => s.stats ? fmtDuration(s.stats.p25) : "—" },
                { key: "median", label: T(UI.median), align: "right", render: (s: any) => <span className="font-medium">{s.stats ? fmtDuration(s.stats.median) : "—"}</span> },
                { key: "p75", label: "P75", align: "right", render: (s: any) => s.stats ? fmtDuration(s.stats.p75) : "—" },
                { key: "max", label: T(UI.max), align: "right", render: (s: any) => s.stats ? fmtDuration(s.stats.max) : "—" },
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
                      { value: "line", icon: LineChart, tooltip: T(UI.line) },
                      { value: "bar", icon: BarChart3, tooltip: T(UI.bar) },
                    ]}
                  />
                </div>
                <ResponsiveContainer width="100%" height={320}>
                  {chartType === "bar" ? (
                    <ReBarChart data={eventData} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" opacity={0.5} />
                      <XAxis dataKey="period" tickFormatter={formatPeriod} tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} width={40} />
                      <Tooltip
                        contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }}
                        labelFormatter={formatPeriod}
                        formatter={(value: any, name: any) => [value, formatDimensionValue(String(name))]}
                      />
                      {hasDimension ? (
                        <>
                          <Legend wrapperStyle={{ fontSize: 11 }} formatter={(value: string) => formatDimensionValue(value)} />
                          {sortedDimensions.map((dim, i) => (
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
                      <Tooltip
                        contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }}
                        labelFormatter={formatPeriod}
                        formatter={(value: any, name: any) => [value, formatDimensionValue(String(name))]}
                      />
                      {hasDimension ? (
                        <>
                          <Legend wrapperStyle={{ fontSize: 11 }} formatter={(value: string) => formatDimensionValue(value)} />
                          {sortedDimensions.map((dim, i) => {
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
              const columns = [
                { key: "period", label: T(UI.period), sortable: true, sortType: "date" as const, render: (d: any) => <span className="text-muted-foreground">{formatPeriod(d.period)}</span> },
                ...(hasDimension ? [{ key: "dimension", label: T(UI.dimension), sortable: true, sortType: dimensionSortType, render: (d: any) => d.dimension == null ? "—" : formatDimensionValue(String(d.dimension)) }] : []),
                { key: "value", label: T(UI.value), align: "right" as const, sortable: true, sortType: "number" as const, render: (d: any) => <span className="font-medium">{d.value.toLocaleString()}</span> },
              ];
              // Clicking "Dimension" fully re-sorts the flattened row array
              // (one row per period x dimension) by the chosen column,
              // matching ResultsTable's single-active-sort-column model —
              // this can intermix periods, which is expected here (see
              // spec section 3), not a bug.
              const activeSortColumn = columns.some((c) => c.key === sortColumn) ? sortColumn : undefined;
              const sortedTableRows = activeSortColumn
                ? [...tableRows].sort((a: any, b: any) =>
                    compareRows(a, b, activeSortColumn, columns.find((c) => c.key === activeSortColumn)?.sortType, sortDirection)
                  )
                : tableRows;
              return (
                <ResultsTable
                  title={T(UI.data)}
                  columns={columns}
                  rows={sortedTableRows}
                  sortKey={sortColumn}
                  sortDir={sortDirection}
                  onSortChange={handleSortChange}
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
                  <p className="text-xs text-muted-foreground">{T(UI.step1Users)}</p>
                  <p className="text-2xl font-bold tracking-tight mt-1">{steps[0].count.toLocaleString()}</p>
                </CardContent></Card>
                <Card><CardContent className="p-4">
                  <p className="text-xs text-muted-foreground">{T(UI.completionRate)}</p>
                  <p className="text-2xl font-bold tracking-tight mt-1">{steps[steps.length - 1].totalRate}%</p>
                </CardContent></Card>
              </div>

              <Card className="mb-4">
                <CardContent className="p-6">
                  <p className="text-sm font-medium text-foreground mb-4">{T(UI.funnel)}</p>
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
                title={T(UI.data)}
                columns={[
                  { key: "idx", label: "#", render: (s: any) => s.idx },
                  { key: "eventType", label: T(UI.event), render: (s: any) => s.eventType },
                  { key: "count", label: T(UI.users), align: "right", render: (s: any) => <span className="font-medium">{s.count.toLocaleString()}</span> },
                  { key: "conversionRate", label: T(UI.conv), align: "right", render: (s: any) => <span className="text-muted-foreground">{s.idx === 1 ? "—" : `${s.conversionRate}%`}</span> },
                  { key: "totalRate", label: T(UI.overall), align: "right", render: (s: any) => <span className="text-muted-foreground">{s.totalRate}%</span> },
                ]}
                rows={steps.map((s, i) => ({ ...s, idx: i + 1 }))}
              />
            </>
          );
        })()}

        {/* User/Content results — Pie/Bar chart + table (no dimension selected collapses to a single Total slice, same code path) */}
        {hasData && (mode === "user" || mode === "content") && (() => {
          const dimensioned = results.data.filter((d: any) => d.dimension != null);
          const totalLabel = mode === "content" ? T(UI.totalContent) : T(UI.totalUsers);
          const data = dimensioned.length > 0
            ? dimensioned
            : results.data.length === 1
              ? [{ dimension: config.measure === "count" ? totalLabel : (config.measureField || T(UI.value)), value: results.data[0].value }]
              : [];
          const total = data.reduce((s: number, d: any) => s + (d.value || 0), 0);
          if (data.length === 0) return null;
          // "%" isn't a real field on each row (it's derived from value/total
          // at render time) — sorting by "%" is a monotonic transform of
          // sorting by "value" (total is always >= 0), so reuse the "value"
          // comparison for it rather than materializing a "pct" field.
          const sortTypeForColumn = sortColumn === "dimension" ? dimensionSortType : "number";
          const effectiveSortKey = sortColumn === "pct" ? "value" : sortColumn;
          const sortedData = [...data].sort((a: any, b: any) =>
            compareRows(a, b, effectiveSortKey, sortTypeForColumn, sortDirection)
          );
          return (
            <>
              <Card className="mb-4">
                <CardContent className="p-6 pt-4">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-sm font-medium text-foreground">{T(UI.distribution)}</p>
                    <ChartTypeToggle
                      value={chartType}
                      onChange={setChartType}
                      options={[
                        { value: "pie", icon: PieChart, tooltip: T(UI.pieChart) },
                        { value: "bar", icon: BarChart3, tooltip: T(UI.bar) },
                      ]}
                    />
                  </div>
                  {chartType === "pie" ? (
                    <div className="flex items-center gap-8">
                      <ResponsiveContainer width="50%" height={280}>
                        <RePieChart>
                          <Pie data={sortedData} dataKey="value" nameKey="dimension" cx="50%" cy="50%" outerRadius={100} innerRadius={50} paddingAngle={2}>
                            {sortedData.map((_: any, i: number) => <Cell key={i} fill={DIMENSION_COLORS[i % DIMENSION_COLORS.length]} />)}
                          </Pie>
                          <Tooltip
                            contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }}
                            formatter={(value: any, name: any) => [value, formatDimensionValue(String(name))]}
                          />
                        </RePieChart>
                      </ResponsiveContainer>
                      <div className="flex-1 space-y-2">
                        {sortedData.map((d: any, i: number) => (
                          <div key={i} className="flex items-center gap-2 text-sm">
                            <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: DIMENSION_COLORS[i % DIMENSION_COLORS.length] }} />
                            <span className="flex-1 truncate text-foreground">{d.dimension == null ? T(C.none) : formatDimensionValue(String(d.dimension))}</span>
                            <span className="text-muted-foreground">{total ? `${Math.round(d.value / total * 100)}%` : "0%"}</span>
                            <span className="font-medium w-16 text-right">{Number(d.value).toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height={280}>
                      <ReBarChart data={sortedData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" opacity={0.5} />
                        <XAxis dataKey="dimension" tickFormatter={(v: any) => formatDimensionValue(String(v))} tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} />
                        <YAxis tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} width={40} />
                        <Tooltip
                          contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }}
                          labelFormatter={(v: any) => formatDimensionValue(String(v))}
                        />
                        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                          {sortedData.map((_: any, i: number) => <Cell key={i} fill={DIMENSION_COLORS[i % DIMENSION_COLORS.length]} />)}
                        </Bar>
                      </ReBarChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              <ResultsTable
                title={T(UI.data)}
                columns={[
                  {
                    key: "dimension", label: T(UI.dimension), sortable: true, sortType: dimensionSortType, render: (d: any) => {
                      const i = sortedData.indexOf(d);
                      return (
                        <span className="flex items-center gap-2">
                          <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: DIMENSION_COLORS[i % DIMENSION_COLORS.length] }} />
                          {d.dimension == null ? T(C.none) : formatDimensionValue(String(d.dimension))}
                        </span>
                      );
                    },
                  },
                  { key: "value", label: T(UI.value), align: "right", sortable: true, sortType: "number", render: (d: any) => Number(d.value).toLocaleString() },
                  { key: "pct", label: "%", align: "right", sortable: true, sortType: "number", render: (d: any) => <span className="text-muted-foreground">{total ? `${Math.round(d.value / total * 100)}%` : "0%"}</span> },
                ]}
                rows={sortedData}
                sortKey={sortColumn}
                sortDir={sortDirection}
                onSortChange={handleSortChange}
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
