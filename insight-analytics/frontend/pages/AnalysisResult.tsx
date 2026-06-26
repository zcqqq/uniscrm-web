import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { getAnalysis, type AnalysisDetail, type BucketItem, type IntervalStats } from "../lib/api";

const EVENT_LABELS: Record<string, string> = {
  "follow.follow": "X Follow",
  "follow.followed": "X Followed",
  "follow.unfollow": "X Unfollow",
  "follow.unfollowed": "X Unfollowed",
  "chat.received": "X Chat Received",
};

export function AnalysisResult() {
  const { id } = useParams<{ id: string }>();
  const [analysis, setAnalysis] = useState<AnalysisDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    getAnalysis(id)
      .then((d) => setAnalysis(d.analysis))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="p-6 text-muted-foreground text-sm">Loading...</div>;
  if (error) return <div className="p-6 text-destructive text-sm">{error}</div>;
  if (!analysis) return <div className="p-6 text-muted-foreground text-sm">Not found</div>;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/" className="text-muted-foreground/60 hover:text-muted-foreground">←</Link>
        <h1 className="text-xl font-semibold text-foreground">
          {EVENT_LABELS[analysis.event_type_a] || analysis.event_type_a} → {EVENT_LABELS[analysis.event_type_b] || analysis.event_type_b}
        </h1>
      </div>

      {analysis.status === "error" && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 text-sm text-red-700">
          {analysis.error_message || "Computation failed"}
        </div>
      )}

      {analysis.status === "computing" && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6 text-sm text-yellow-700">
          Computing... Please refresh in a moment.
        </div>
      )}

      {analysis.results && (
        <>
          <StatsCard stats={analysis.results.stats} totalProfiles={analysis.results.total_profiles} />
          <Histogram buckets={analysis.results.buckets} />
          <BoxPlot stats={analysis.results.stats} />
        </>
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
    <div className="bg-card rounded-lg border border-border p-5 mb-6">
      <h2 className="text-sm font-medium text-foreground mb-3">Statistics</h2>
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-4">
        {items.map((item) => (
          <div key={item.label}>
            <div className="text-xs text-muted-foreground">{item.label}</div>
            <div className="text-sm font-semibold text-foreground mt-0.5">{item.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Histogram({ buckets }: { buckets: BucketItem[] }) {
  const maxCount = Math.max(...buckets.map((b) => b.count), 1);

  return (
    <div className="bg-card rounded-lg border border-border p-5 mb-6">
      <h2 className="text-sm font-medium text-foreground mb-4">Distribution</h2>
      <div className="space-y-2">
        {buckets.map((bucket) => (
          <div key={bucket.label} className="flex items-center gap-3">
            <div className="w-20 text-xs text-muted-foreground text-right shrink-0">{bucket.label}</div>
            <div className="flex-1 h-6 bg-gray-100 rounded overflow-hidden relative">
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
    </div>
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
    <div className="bg-card rounded-lg border border-border p-5">
      <h2 className="text-sm font-medium text-foreground mb-4">Box Plot</h2>
      <div className="relative h-12 mx-4">
        {/* Whisker line */}
        <div
          className="absolute top-1/2 h-px bg-gray-400"
          style={{ left: `${minPos}%`, width: `${maxPos - minPos}%`, transform: "translateY(-50%)" }}
        />
        {/* Min whisker */}
        <div
          className="absolute top-1/2 w-px h-4 bg-gray-400 -translate-y-1/2"
          style={{ left: `${minPos}%` }}
        />
        {/* Max whisker */}
        <div
          className="absolute top-1/2 w-px h-4 bg-gray-400 -translate-y-1/2"
          style={{ left: `${maxPos}%` }}
        />
        {/* IQR box */}
        <div
          className="absolute top-1/2 h-8 bg-blue-100 border border-blue-400 rounded -translate-y-1/2"
          style={{ left: `${p25Pos}%`, width: `${p75Pos - p25Pos}%` }}
        />
        {/* Median line */}
        <div
          className="absolute top-1/2 w-0.5 h-8 bg-blue-700 -translate-y-1/2"
          style={{ left: `${medianPos}%` }}
        />
      </div>
      <div className="flex justify-between mx-4 mt-2 text-xs text-muted-foreground">
        <span>{formatDuration(stats.min)}</span>
        <span>P25: {formatDuration(stats.p25)}</span>
        <span>Median: {formatDuration(stats.median)}</span>
        <span>P75: {formatDuration(stats.p75)}</span>
        <span>{formatDuration(stats.max)}</span>
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}
