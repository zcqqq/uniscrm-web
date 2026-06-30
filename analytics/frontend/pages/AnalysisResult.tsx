import { useState, useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { getReport, createReport, type ReportSummary, type BucketItem, type IntervalStats, type EventAnalysisResults } from "../lib/api";
import { useLocale } from "../hooks/useLocale";
import { ReportConfig, type ReportConfigValues } from "../components/ReportConfig";
import { Button } from "../../../shared/frontend/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../shared/frontend/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../../shared/frontend/ui/table";
import { Skeleton } from "../../../shared/frontend/ui/skeleton";

const EVENT_LABELS: Record<string, string> = {
  "follow.follow": "X Follow",
  "follow.followed": "X Followed",
  "follow.unfollow": "X Unfollow",
  "follow.unfollowed": "X Unfollowed",
  "dm.received": "X DM Received",
};

export function AnalysisResult() {
  const { id } = useParams<{ id: string }>();
  const [report, setReport] = useState<ReportSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchReport = () => {
    if (!id) return;
    getReport(id)
      .then((d) => setReport(d.report))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchReport();
  }, [id]);

  useEffect(() => {
    if (!report || (report.status !== "pending" && report.status !== "computing")) return;
    const timer = setInterval(fetchReport, 3000);
    return () => clearInterval(timer);
  }, [report?.status]);

  if (loading) return <div className="p-6 space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-40 w-full" /></div>;
  if (error) return <div className="p-6 text-destructive text-sm">{error}</div>;
  if (!report) return <div className="p-6 text-muted-foreground text-sm">Not found</div>;

  const eventA = String(report.params.event_type_a || "");
  const eventB = String(report.params.event_type_b || "");

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/analytics" className="text-muted-foreground/60 hover:text-muted-foreground">←</Link>
        <h1 className="text-xl font-semibold text-foreground">
          {report.type === "event"
            ? (EVENT_LABELS[String(report.params.event_type || "")] || report.params.event_type || "Event Analysis")
            : `${EVENT_LABELS[eventA] || eventA} → ${EVENT_LABELS[eventB] || eventB}`
          }
        </h1>
      </div>

      {report.status === "error" && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-4 mb-6 text-sm text-destructive">
          {report.error_message || "Computation failed"}
        </div>
      )}

      {(report.status === "pending" || report.status === "computing") && (
        <div className="bg-warning/10 border border-warning/20 rounded-lg p-4 mb-6 text-sm text-warning-foreground flex items-center gap-2">
          <span className="animate-spin">⏳</span>
          {report.status === "pending" ? "Queued..." : "Computing via R2 SQL..."}
        </div>
      )}

      {report.status === "ready" && report.results && "stats" in report.results && (
        <>
          <StatsCard stats={report.results.stats} totalProfiles={report.results.total_profiles} />
          <Histogram buckets={report.results.buckets} />
          <BoxPlot stats={report.results.stats} />
          {report.results.sql && <SqlBlock sql={report.results.sql} />}
        </>
      )}

      {report.status === "ready" && report.results && "data" in report.results && (
        <EventResultsView results={report.results as EventAnalysisResults} params={report.params} />
      )}
    </div>
  );
}

function StatsCard({ stats, totalProfiles }: { stats: IntervalStats; totalProfiles: number }) {
  const items = [
    { label: "Pairs", value: stats.count.toLocaleString() },
    { label: "Profiles", value: totalProfiles.toLocaleString() },
    { label: "Median", value: formatDuration(stats.median) },
    { label: "Average", value: formatDuration(stats.avg) },
    { label: "P25", value: formatDuration(stats.p25) },
    { label: "P75", value: formatDuration(stats.p75) },
    { label: "P90", value: formatDuration(stats.p90) },
    { label: "Min", value: formatDuration(stats.min) },
    { label: "Max", value: formatDuration(stats.max) },
  ];

  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Statistics</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-4">
          {items.map((item) => (
            <div key={item.label}>
              <div className="text-xs text-muted-foreground">{item.label}</div>
              <div className="text-sm font-semibold text-foreground mt-0.5">{item.value}</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function Histogram({ buckets }: { buckets: BucketItem[] }) {
  const maxCount = Math.max(...buckets.map((b) => b.count), 1);

  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Distribution</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {buckets.map((bucket) => (
            <div key={bucket.label} className="flex items-center gap-3">
              <div className="w-20 text-xs text-muted-foreground text-right shrink-0">{bucket.label}</div>
              <div className="flex-1 h-6 bg-muted rounded overflow-hidden relative">
                <div
                  className="h-full bg-primary rounded transition-all"
                  style={{ width: `${(bucket.count / maxCount) * 100}%` }}
                />
              </div>
              <div className="w-16 text-xs text-muted-foreground text-right shrink-0">
                {bucket.count > 0 ? `${bucket.percentage}%` : "—"}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function BoxPlot({ stats }: { stats: IntervalStats }) {
  if (stats.count === 0) return null;

  const range = stats.max - stats.min || 1;
  const scale = (v: number) => ((v - stats.min) / range) * 100;

  const p25Pos = scale(stats.p25);
  const medianPos = scale(stats.median);
  const p75Pos = scale(stats.p75);
  const minPos = scale(stats.min);
  const maxPos = scale(stats.max);

  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Box Plot</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative h-12 mx-4">
          <div
            className="absolute top-1/2 h-px bg-muted-foreground/40"
            style={{ left: `${minPos}%`, width: `${maxPos - minPos}%`, transform: "translateY(-50%)" }}
          />
          <div className="absolute top-1/2 w-px h-4 bg-muted-foreground/40 -translate-y-1/2" style={{ left: `${minPos}%` }} />
          <div className="absolute top-1/2 w-px h-4 bg-muted-foreground/40 -translate-y-1/2" style={{ left: `${maxPos}%` }} />
          <div
            className="absolute top-1/2 h-8 bg-primary/10 border border-primary/40 rounded -translate-y-1/2"
            style={{ left: `${p25Pos}%`, width: `${p75Pos - p25Pos}%` }}
          />
          <div className="absolute top-1/2 w-0.5 h-8 bg-primary -translate-y-1/2" style={{ left: `${medianPos}%` }} />
        </div>
        <div className="flex justify-between mx-4 mt-2 text-xs text-muted-foreground">
          <span>{formatDuration(stats.min)}</span>
          <span>P25: {formatDuration(stats.p25)}</span>
          <span>Median: {formatDuration(stats.median)}</span>
          <span>P75: {formatDuration(stats.p75)}</span>
          <span>{formatDuration(stats.max)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function SqlBlock({ sql }: { sql: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardContent className="p-5">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 px-0 hover:bg-transparent"
        >
          <span className={`transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
          SQL Query
        </Button>
        {open && (
          <pre className="mt-3 p-3 bg-muted rounded text-xs text-muted-foreground overflow-x-auto whitespace-pre-wrap font-mono">
            {sql}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

const MEASURE_LABELS: Record<string, string> = { count: "Total count", users: "Unique users", avg: "Per-user avg" };

function EventResultsView({ results, params }: { results: EventAnalysisResults; params: Record<string, unknown> }) {
  const { timezone } = useLocale();
  const navigate = useNavigate();
  const [config, setConfig] = useState<ReportConfigValues>({
    eventType: String(params.event_type || ""),
    measure: (params.measure as any) || "count",
    dimension: String(params.dimension || ""),
    timeRange: inferTimeRange(String(params.time_range_start || "")),
    granularity: (params.granularity as any) || "day",
  });
  const [computing, setComputing] = useState(false);

  const chartData = results.data.map((d) => ({ period: d.period, value: d.value }));

  const formatPeriod = (p: string) => {
    try {
      const normalized = p.replace(/(\.\d{3})\d+Z$/, "$1Z");
      const d = new Date(normalized);
      if (isNaN(d.getTime())) return p.slice(0, 10);
      return d.toLocaleDateString(undefined, { timeZone: timezone, month: "short", day: "numeric" });
    } catch { return p.slice(0, 10); }
  };

  const handleConfigChange = async (newConfig: ReportConfigValues) => {
    setConfig(newConfig);
    if (!newConfig.eventType) return;
    setComputing(true);
    const start = new Date(Date.now() - parseInt(newConfig.timeRange) * 86400000).toISOString().slice(0, 10);
    try {
      const res = await createReport({
        type: "event",
        params: { event_type: newConfig.eventType, measure: newConfig.measure, dimension: newConfig.dimension || undefined, granularity: newConfig.granularity, time_range_start: start },
      });
      navigate(`/analytics/${res.report.id}`);
    } catch { setComputing(false); }
  };

  return (
    <>
      <ReportConfig values={config} onChange={handleConfigChange} />

      {computing ? (
        <div className="text-center py-12 text-muted-foreground text-sm">Computing...</div>
      ) : (
        <>
          <Card className="mb-5">
            <CardContent className="p-5">
              {chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height={280}>
                  <AreaChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" opacity={0.4} />
                    <XAxis dataKey="period" tickFormatter={formatPeriod} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={40} />
                    <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} labelFormatter={formatPeriod} />
                    <Area type="monotone" dataKey="value" stroke="hsl(var(--primary))" fill="hsl(var(--primary))" fillOpacity={0.08} strokeWidth={2} dot={{ r: 3, fill: "hsl(var(--primary))" }} activeDot={{ r: 5 }} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="text-center py-12 text-muted-foreground text-sm">No data</div>
              )}
            </CardContent>
          </Card>

          {chartData.length > 0 && (
            <div className="mb-5">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/30">
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">
                      {MEASURE_LABELS[config.measure]}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {chartData.map((row, i) => (
                    <TableRow key={i}>
                      <TableCell>{formatPeriod(row.period)}</TableCell>
                      <TableCell className="text-right font-medium">{row.value}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {results.sql && <SqlBlock sql={results.sql} />}
        </>
      )}
    </>
  );
}

function inferTimeRange(startDate: string): string {
  if (!startDate) return "7";
  const days = Math.round((Date.now() - new Date(startDate).getTime()) / 86400000);
  if (days <= 7) return "7";
  if (days <= 14) return "14";
  if (days <= 30) return "30";
  return "90";
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}
