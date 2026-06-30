import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { createReport, getReport, listDashboards, createDashboard, addDashboardItem, type Dashboard } from "../lib/api";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
import { useLocale } from "../hooks/useLocale";
import { ReportConfig, type ReportConfigValues } from "../components/ReportConfig";
import { Button } from "../../../shared/frontend/ui/button";
import { Input } from "../../../shared/frontend/ui/input";
import { Card, CardContent } from "../../../shared/frontend/ui/card";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../../../shared/frontend/ui/dropdown-menu";

const MODE_TITLES: Record<string, { en: string; zh: string }> = {
  event: { en: "Event Analysis", zh: "事件分析" },
  interval: { en: "Interval Analysis", zh: "间隔分析" },
};

export function AnalysisCreate({ mode = "event" }: { mode?: "event" | "interval" }) {
  const navigate = useNavigate();
  const { locale, timezone } = useLocale();
  const title = MODE_TITLES[mode]?.[locale] || MODE_TITLES[mode]?.en || mode;

  const { toast } = useToast();
  useEffect(() => { document.title = `${title} — UniSCRM`; }, [title]);
  const [name, setName] = useState(`Untitled ${MODE_TITLES[mode]?.en || "Analysis"}`);
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

  const [reportId, setReportId] = useState<string | null>(null);
  const [results, setResults] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [dashDropOpen, setDashDropOpen] = useState(false);

  useEffect(() => { listDashboards().then((d) => setDashboards(d.dashboards)); }, []);

  const runQuery = useCallback(async () => {
    if (mode === "interval" && (!config.eventTypeA || !config.eventTypeB)) return;
    if (mode === "event" && !config.eventType) return;
    setLoading(true);
    setError("");
    setResults(null);

    const start = new Date(Date.now() - parseInt(config.timeRange) * 86400000).toISOString().slice(0, 10);

    try {
      const params = mode === "interval"
        ? { event_type_a: config.eventTypeA, event_type_b: config.eventTypeB, dimension: config.dimension || undefined, granularity: config.granularity, time_range_start: start, filters: config.filters }
        : { event_type: config.eventType, measure: config.measure, dimension: config.dimension || undefined, granularity: config.granularity, time_range_start: start, filters: config.filters };

      const res = await createReport({ type: mode, params });
      setReportId(res.report.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      setLoading(false);
    }
  }, [config]);

  useEffect(() => {
    if (!reportId) return;
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
        }
      } catch {}
    }, 2000);
    return () => clearInterval(poll);
  }, [reportId]);

  useEffect(() => {
    runQuery();
  }, [runQuery]);

  const formatPeriod = (p: string) => {
    try {
      const normalized = p.replace(/(\.\d{3})\d+Z$/, "$1Z");
      const d = new Date(normalized);
      if (isNaN(d.getTime())) return p.slice(0, 10);
      return d.toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", { timeZone: timezone, month: "short", day: "numeric" });
    } catch { return p.slice(0, 10); }
  };

  const hasStats = results && "stats" in results;
  const hasData = results && "data" in results;

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
        <Button size="sm" onClick={() => navigate("/analytics")}>Save</Button>
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

        {/* Event results — KPI + time series chart */}
        {hasData && results.data.length > 0 && (
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
                  <p className="text-2xl font-bold tracking-tight mt-1">{results.data.length}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <p className="text-xs font-medium text-muted-foreground">{locale === "zh" ? "峰值" : "Peak"}</p>
                  <p className="text-2xl font-bold tracking-tight mt-1">{Math.max(...results.data.map((d: any) => d.value || 0)).toLocaleString()}</p>
                </CardContent>
              </Card>
            </div>
            <Card className="mb-4">
              <CardContent className="p-6 pt-4">
                <p className="text-sm font-medium text-foreground mb-4">{locale === "zh" ? "趋势" : "Trend"}</p>
                <ResponsiveContainer width="100%" height={320}>
                  <AreaChart data={results.data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                    <defs>
                      <linearGradient id="gradEvent" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.2} />
                        <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.01} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" opacity={0.5} />
                    <XAxis dataKey="period" tickFormatter={formatPeriod} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={40} />
                    <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }} labelFormatter={formatPeriod} />
                    <Area type="natural" dataKey="value" stroke="hsl(var(--primary))" fill="url(#gradEvent)" strokeWidth={2.5} dot={false} activeDot={{ r: 4, fill: "hsl(var(--primary))", stroke: "hsl(var(--background))", strokeWidth: 2 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </>
        )}

        {/* SQL */}
        {results?.sql && (
          <Card>
            <details className="group">
              <summary className="px-6 py-4 text-sm font-medium text-foreground cursor-pointer flex items-center gap-2">
                <span className="transition-transform group-open:rotate-90">▶</span>
                SQL Query
              </summary>
              <CardContent className="px-6 pb-4 pt-0">
                <pre className="p-4 bg-muted rounded-md text-xs text-muted-foreground overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed">{results.sql}</pre>
              </CardContent>
            </details>
          </Card>
        )}
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
