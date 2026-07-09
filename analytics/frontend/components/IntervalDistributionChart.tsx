import { ResponsiveContainer, ComposedChart, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import type { IntervalStats, BucketItem } from "../lib/api";
import { fmtDuration } from "../lib/format";

export type DistributionChartType = "histogram" | "boxplot";

const UI = {
  en: { min: "Min", p25: "P25", median: "Median", p75: "P75", max: "Max" },
  zh: { min: "最小值", p25: "P25", median: "中位数", p75: "P75", max: "最大值" },
};

/**
 * Renders the Interval Analysis "Distribution" chart as either a histogram
 * (bucket counts) or a box plot (min/p25/median/p75/max), sharing the exact
 * same visual language (axis, grid, tooltip) between the full Analytics
 * Detail page and the compact Dashboard widget.
 */
export function IntervalDistributionChart({
  stats,
  buckets,
  chartType,
  locale,
  height = 280,
  compact = false,
}: {
  stats: IntervalStats;
  buckets: BucketItem[];
  chartType: DistributionChartType;
  locale: "en" | "zh";
  height?: number;
  compact?: boolean;
}) {
  const t = UI[locale] || UI.en;
  const tickFontSize = compact ? 9 : 10;
  const axisWidth = compact ? 28 : 36;

  if (chartType === "histogram") {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={buckets} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" opacity={0.5} />
          <XAxis dataKey="label" tick={compact ? false : { fontSize: tickFontSize, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} />
          <YAxis tick={compact ? false : { fontSize: tickFontSize, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} width={compact ? 0 : axisWidth} />
          {!compact && (
            <Tooltip
              contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }}
              formatter={(value: any, _name: any, ctx: any) => [`${Number(value).toLocaleString()} (${ctx?.payload?.percentage ?? 0}%)`, locale === "zh" ? "数量" : "Count"]}
            />
          )}
          <Bar dataKey="count" fill="var(--color-primary)" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    );
  }

  // Box plot: single vertical box (min/p25/median/p75/max), Y-axis auto-fits
  // to the data range rather than starting at 0, so the box stays readable
  // even though interval durations can span seconds to weeks.
  // even though interval durations can span seconds to weeks. Derive the
  // range from every stat field (not just min/max) so a rounding mismatch
  // between backend-computed percentiles can never push the box outside
  // the visible domain.
  const allValues = [stats.min, stats.p25, stats.median, stats.p75, stats.max];
  const rawMin = Math.min(...allValues);
  const rawMax = Math.max(...allValues);
  const span = Math.max(rawMax - rawMin, 1);
  const pad = span * 0.15;
  const domainMin = Math.max(0, rawMin - pad);
  const domainMax = rawMax + pad;
  const data = [{ name: "value", ...stats }];

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" opacity={0.5} />
        <XAxis dataKey="name" tick={false} axisLine={false} tickLine={false} />
        <YAxis
          domain={[domainMin, domainMax]}
          tickFormatter={fmtDuration}
          tick={compact ? false : { fontSize: tickFontSize, fill: "var(--color-muted-foreground)" }}
          tickLine={false}
          axisLine={false}
          width={compact ? 0 : axisWidth}
        />
        {!compact && (
          <Tooltip
            cursor={false}
            content={({ active }) =>
              active ? (
                <div
                  style={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }}
                  className="px-3 py-2 space-y-0.5"
                >
                  {[
                    [t.max, stats.max],
                    [t.p75, stats.p75],
                    [t.median, stats.median],
                    [t.p25, stats.p25],
                    [t.min, stats.min],
                  ].map(([label, val]) => (
                    <div key={label as string} className="flex items-center justify-between gap-4">
                      <span className="text-muted-foreground">{label}</span>
                      <span className="font-medium tabular-nums">{fmtDuration(val as number)}</span>
                    </div>
                  ))}
                </div>
              ) : null
            }
          />
        )}
        <Bar dataKey="max" barSize={compact ? 24 : 40} fill="transparent" background={{ fill: "transparent" }} isAnimationActive={false} shape={(props: any) => (
          <BoxPlotShape {...props} stats={stats} domainMin={domainMin} domainMax={domainMax} compact={compact} />
        )} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function BoxPlotShape({ background, stats, domainMin, domainMax, compact }: {
  background?: { x: number; y: number; width: number; height: number };
  stats: IntervalStats;
  domainMin: number;
  domainMax: number;
  compact?: boolean;
}) {
  if (!background) return null;
  const { x, y, width, height } = background;
  const scaleY = (v: number) => y + ((domainMax - v) / (domainMax - domainMin)) * height;

  const boxWidth = width * 0.4;
  const cx = x + width / 2;
  const boxX = cx - boxWidth / 2;
  const capHalf = boxWidth / 4;

  const yMin = scaleY(stats.min);
  const yP25 = scaleY(stats.p25);
  const yMedian = scaleY(stats.median);
  const yP75 = scaleY(stats.p75);
  const yMax = scaleY(stats.max);

  const color = "var(--color-primary)";
  const strokeWidth = compact ? 1 : 1.5;

  return (
    <g>
      {/* Whisker line spanning min → max */}
      <line x1={cx} y1={yMin} x2={cx} y2={yMax} stroke={color} strokeWidth={strokeWidth} />
      {/* Min cap */}
      <line x1={cx - capHalf} y1={yMin} x2={cx + capHalf} y2={yMin} stroke={color} strokeWidth={strokeWidth} />
      {/* Max cap */}
      <line x1={cx - capHalf} y1={yMax} x2={cx + capHalf} y2={yMax} stroke={color} strokeWidth={strokeWidth} />
      {/* Box: p25–p75 */}
      <rect x={boxX} y={yP75} width={boxWidth} height={Math.max(1, yP25 - yP75)} fill={color} fillOpacity={0.15} stroke={color} strokeWidth={strokeWidth + 0.5} />
      {/* Median line */}
      <line x1={boxX} y1={yMedian} x2={boxX + boxWidth} y2={yMedian} stroke={color} strokeWidth={strokeWidth + 0.5} />
    </g>
  );
}
