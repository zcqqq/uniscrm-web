import { ResponsiveContainer, ComposedChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import type { IntervalPeriodStats } from "../lib/api";
import { fmtDuration } from "../lib/format";

const UI = {
  en: { min: "Min", p25: "P25", median: "Median", p75: "P75", max: "Max", count: "Pairs", noData: "No data" },
  zh: { min: "最小值", p25: "P25", median: "中位数", p75: "P75", max: "最大值", count: "配对数", noData: "无数据" },
};

/**
 * Renders the Interval Analytics "Distribution" chart as a multi-period box
 * plot — one vertical box per time period (day/week/month, matching the
 * report's granularity), sharing a single recharts Y-axis so the visual
 * language (axis, grid, tooltip) stays consistent with Event Analytics.
 *
 * Implementation note: recharts has no built-in box plot. Rather than
 * computing our own Y domain and manually mapping values to pixels (which
 * previously broke whenever backend rounding made min/max inconsistent with
 * the padded domain), we let the Y-axis auto-compute its domain exactly like
 * Event Analytics does (no explicit `domain` prop). We then derive pixel
 * positions for min/p25/median/p75 by reading the *actual rendered geometry*
 * of an invisible reference Bar (dataKey = max), which recharts positions
 * using the real resolved scale regardless of what "nice" domain it picked.
 * Since the scale is linear and passes through (0, baseline) and
 * (max, barTop), any other value in [0, max] can be interpolated from those
 * two known pixel references — no manual domain math required.
 */
export function IntervalDistributionChart({
  slots,
  locale,
  height = 280,
  compact = false,
  tickFormatter,
}: {
  slots: { period: string; stats: IntervalPeriodStats | null }[];
  locale: "en" | "zh";
  height?: number;
  compact?: boolean;
  tickFormatter?: (period: string) => string;
}) {
  const t = UI[locale] || UI.en;
  const tickFontSize = compact ? 9 : 11;
  const axisWidth = compact ? 28 : 40;
  const barSize = compact ? 20 : 40;

  const data = slots.map((s) => ({ period: s.period, stats: s.stats, __max: s.stats?.max ?? 0 }));
  const hasAnyData = slots.some((s) => s.stats);

  if (!hasAnyData) {
    return (
      <div className="flex items-center justify-center text-muted-foreground text-xs" style={{ height }}>
        {t.noData}
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" opacity={0.5} />
        <XAxis
          dataKey="period"
          tickFormatter={tickFormatter}
          tick={compact ? false : { fontSize: tickFontSize, fill: "var(--color-muted-foreground)" }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tickFormatter={fmtDuration}
          tick={compact ? false : { fontSize: tickFontSize, fill: "var(--color-muted-foreground)" }}
          tickLine={false}
          axisLine={false}
          width={compact ? 0 : axisWidth}
        />
        {!compact && (
          <Tooltip
            cursor={{ fill: "var(--color-muted)", opacity: 0.3 }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const slot = payload[0]?.payload as { period: string; stats: IntervalPeriodStats | null };
              const stats = slot?.stats;
              return (
                <div
                  style={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }}
                  className="px-3 py-2 space-y-0.5"
                >
                  <div className="font-medium text-foreground pb-1 mb-1 border-b border-border">{tickFormatter ? tickFormatter(slot.period) : slot.period}</div>
                  {stats ? (
                    [
                      [t.count, stats.count.toLocaleString()],
                      [t.max, fmtDuration(stats.max)],
                      [t.p75, fmtDuration(stats.p75)],
                      [t.median, fmtDuration(stats.median)],
                      [t.p25, fmtDuration(stats.p25)],
                      [t.min, fmtDuration(stats.min)],
                    ].map(([label, val]) => (
                      <div key={label} className="flex items-center justify-between gap-4">
                        <span className="text-muted-foreground">{label}</span>
                        <span className="font-medium tabular-nums">{val}</span>
                      </div>
                    ))
                  ) : (
                    <span className="text-muted-foreground">{t.noData}</span>
                  )}
                </div>
              );
            }}
          />
        )}
        <Bar
          dataKey="__max"
          barSize={barSize}
          fill="transparent"
          isAnimationActive={false}
          shape={(props: any) => <BoxPlotShape {...props} compact={compact} />}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function BoxPlotShape({ x, y, width, height, payload, compact }: {
  x: number; y: number; width: number; height: number;
  payload?: { stats: IntervalPeriodStats | null };
  compact?: boolean;
}) {
  const stats = payload?.stats;
  if (!stats || !stats.max) return null;

  // (x, y, width, height) is THIS bar's own rendered rectangle for value
  // "max", using whatever Y-scale recharts resolved. Its bottom edge is the
  // pixel for value 0; its top edge is the pixel for value `max`. Both are
  // exact regardless of the axis's auto-computed domain, so every other
  // stat can be interpolated linearly between them.
  const yZero = y + height;
  const pxPerUnit = height / stats.max;
  const scaleY = (v: number) => yZero - v * pxPerUnit;

  const boxWidth = width * 0.55;
  const cx = x + width / 2;
  const boxX = cx - boxWidth / 2;
  const capHalf = boxWidth / 3;

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
      <rect x={boxX} y={yP75} width={boxWidth} height={Math.max(2, yP25 - yP75)} fill={color} fillOpacity={0.35} stroke={color} strokeWidth={strokeWidth + 1} />
      {/* Median line */}
      <line x1={boxX} y1={yMedian} x2={boxX + boxWidth} y2={yMedian} stroke={color} strokeWidth={strokeWidth + 1} />
    </g>
  );
}
