import { useState } from "react";
import { EventMetadata_X } from "../../../metadata/x";
import { t } from "../../../metadata/locale";
import { SelectProps } from "../../../shared/frontend/components/SelectProps";
import { useLocale } from "../hooks/useLocale";
import { Select } from "../../../shared/frontend/ui/select";
import { Input } from "../../../shared/frontend/ui/input";
import { Card, CardContent } from "../../../shared/frontend/ui/card";
import { Label } from "../../../shared/frontend/ui/label";
import { Button } from "../../../shared/frontend/ui/button";
import { Checkbox } from "../../../shared/frontend/ui/checkbox";

const TRIGGER_EVENTS = EventMetadata_X.filter((e) => e.flowType !== "action");

const UI = {
  en: {
    measure: "Measure", dimension: "Dimension", selectEvent: "Select event...",
    totalCount: "Total count", uniqueUsers: "Unique users", perUserAvg: "Per-user avg",
    noGroup: "No grouping", viewBy: "View by",
    today: "Today", yesterday: "Yesterday", thisWeek: "This week", lastWeek: "Last week",
    thisMonth: "This month", lastMonth: "Last month",
    last7d: "Last 7 days", last14d: "Last 14 days", last30d: "Last 30 days", last90d: "Last 90 days", last180d: "Last 180 days", last360d: "Last 360 days",
    total: "Total", day: "Day", week: "Week", month: "Month", hour: "Hour", weekday: "Weekday",
    compare: "Compare period", filter: "Filter", addFilter: "Add filter",
    between: "between", hasValue: "has value", noValue: "no value",
  },
  zh: {
    measure: "选择指标", dimension: "选择维度", selectEvent: "选择事件...",
    totalCount: "总次数", uniqueUsers: "总人数", perUserAvg: "人均次数",
    noGroup: "不分组", viewBy: "按",
    today: "今天", yesterday: "昨天", thisWeek: "本周", lastWeek: "上周",
    thisMonth: "本月", lastMonth: "上月",
    last7d: "过去7天", last14d: "过去14天", last30d: "过去30天", last90d: "过去90天", last180d: "过去180天", last360d: "过去360天",
    total: "按总体", day: "按日", week: "按周", month: "按月", hour: "按小时", weekday: "按周几",
    compare: "对比时间", filter: "筛选条件", addFilter: "添加条件",
    between: "介于", hasValue: "有值", noValue: "无值",
  },
};

const TIME_RANGES = [
  { value: "today", key: "today" as const },
  { value: "yesterday", key: "yesterday" as const },
  { value: "thisWeek", key: "thisWeek" as const },
  { value: "lastWeek", key: "lastWeek" as const },
  { value: "thisMonth", key: "thisMonth" as const },
  { value: "lastMonth", key: "lastMonth" as const },
  { value: "7", key: "last7d" as const },
  { value: "14", key: "last14d" as const },
  { value: "30", key: "last30d" as const },
  { value: "90", key: "last90d" as const },
  { value: "180", key: "last180d" as const },
  { value: "360", key: "last360d" as const },
];

const OPERATORS = ["=", "≠", ">", "<", ">=", "<=", "between", "has value", "no value"] as const;

export interface FilterCondition {
  field: string;
  operator: string;
  value: string;
  value2?: string;
}

export interface ReportConfigValues {
  mode?: "event" | "interval";
  eventType: string;
  measure: "count" | "users" | "avg";
  eventTypeA?: string;
  eventTypeB?: string;
  dimension: string;
  timeRange: string;
  granularity: "total" | "day" | "week" | "month" | "hour" | "weekday";
  compareEnabled?: boolean;
  compareTimeRange?: string;
  filters?: FilterCondition[];
}

interface ReportConfigProps {
  values: ReportConfigValues;
  onChange: (values: ReportConfigValues) => void;
  mode?: "event" | "interval";
}

export function ReportConfig({ values, onChange, mode: modeProp }: ReportConfigProps) {
  const { locale } = useLocale();
  const s = UI[locale];
  const mode = modeProp || values.mode || "event";
  const [showFilter, setShowFilter] = useState((values.filters?.length || 0) > 0);

  const update = (partial: Partial<ReportConfigValues>) => onChange({ ...values, ...partial });

  const addFilter = () => {
    const filters = [...(values.filters || []), { field: "", operator: "=", value: "" }];
    update({ filters });
  };

  const updateFilter = (idx: number, partial: Partial<FilterCondition>) => {
    const filters = [...(values.filters || [])];
    filters[idx] = { ...filters[idx], ...partial };
    update({ filters });
  };

  const removeFilter = (idx: number) => {
    const filters = (values.filters || []).filter((_, i) => i !== idx);
    update({ filters });
  };

  return (
    <Card className="mb-5">
      <CardContent className="p-5">
        {/* Measure (event) or Event Pair (interval) */}
        <div className="flex gap-8 flex-wrap">
          <div className="flex-1 min-w-[280px]">
            {mode === "interval" ? (
              <>
                <Label className="mb-2 block">{locale === "zh" ? "定义行为事件" : "Define Events"}</Label>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-16">{locale === "zh" ? "初始行为" : "Initial"}</span>
                    <Select value={values.eventTypeA || ""} onChange={(e) => update({ eventTypeA: e.target.value })}>
                      <option value="">{s.selectEvent}</option>
                      {TRIGGER_EVENTS.map((e) => <option key={e.eventType} value={e.eventType}>{t(e.label, locale)}</option>)}
                    </Select>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-16">{locale === "zh" ? "结束行为" : "Follow-up"}</span>
                    <Select value={values.eventTypeB || ""} onChange={(e) => update({ eventTypeB: e.target.value })}>
                      <option value="">{s.selectEvent}</option>
                      {TRIGGER_EVENTS.map((e) => <option key={e.eventType} value={e.eventType}>{t(e.label, locale)}</option>)}
                    </Select>
                  </div>
                </div>
              </>
            ) : (
              <>
                <Label className="mb-2 block">{s.measure}</Label>
                <div className="flex items-center gap-2 flex-wrap">
                  <Select value={values.eventType} onChange={(e) => update({ eventType: e.target.value })}>
                    <option value="">{s.selectEvent}</option>
                    {TRIGGER_EVENTS.map((e) => <option key={e.eventType} value={e.eventType}>{t(e.label, locale)}</option>)}
                  </Select>
                  <span className="text-muted-foreground text-sm">→</span>
                  <Select value={values.measure} onChange={(e) => update({ measure: e.target.value as any })}>
                    <option value="count">{s.totalCount}</option>
                    <option value="users">{s.uniqueUsers}</option>
                    <option value="avg">{s.perUserAvg}</option>
                  </Select>
                </div>
              </>
            )}
          </div>
          <div className="flex-1 min-w-[200px]">
            <Label className="mb-2 block">{s.dimension}</Label>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">{s.viewBy}</span>
              <SelectProps
                eventType={mode === "interval" ? (values.eventTypeA || "") : values.eventType}
                value={values.dimension}
                onChange={(v) => update({ dimension: v })}
                locale={locale}
                placeholder={s.noGroup}
              />
            </div>
          </div>
        </div>

        {/* Filter conditions */}
        {showFilter && (values.filters || []).length > 0 && (
          <div className="mt-4 space-y-2">
            {(values.filters || []).map((f, i) => (
              <div key={i} className="flex items-center gap-2 flex-wrap">
                <SelectProps
                  eventType={values.eventType}
                  value={f.field}
                  onChange={(v) => updateFilter(i, { field: v })}
                  locale={locale}
                  placeholder={locale === "zh" ? "选择属性" : "Select field"}
                />
                <Select value={f.operator} onChange={(e) => updateFilter(i, { operator: e.target.value })} className="h-7 text-xs">
                  {OPERATORS.map((op) => <option key={op} value={op}>{op === "between" ? s.between : op === "has value" ? s.hasValue : op === "no value" ? s.noValue : op}</option>)}
                </Select>
                {f.operator !== "has value" && f.operator !== "no value" && (
                  <Input type="text" value={f.value} onChange={(e) => updateFilter(i, { value: e.target.value })} className="h-7 w-20 text-xs" placeholder="value" />
                )}
                {f.operator === "between" && (
                  <Input type="text" value={f.value2 || ""} onChange={(e) => updateFilter(i, { value2: e.target.value })} className="h-7 w-20 text-xs" placeholder="max" />
                )}
                <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={() => removeFilter(i)}>✕</Button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3">
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => { setShowFilter(true); addFilter(); }}>
            + {s.addFilter}
          </Button>
        </div>

        {/* Time range + Granularity + Compare */}
        <div className="flex items-center gap-3 mt-4 flex-wrap">
          <Select value={values.timeRange} onChange={(e) => update({ timeRange: e.target.value })}>
            {TIME_RANGES.map((r) => <option key={r.value} value={r.value}>{s[r.key]}</option>)}
          </Select>
          <Select value={values.granularity} onChange={(e) => update({ granularity: e.target.value as any })}>
            <option value="total">{s.total}</option>
            <option value="day">{s.day}</option>
            <option value="week">{s.week}</option>
            <option value="month">{s.month}</option>
            <option value="hour">{s.hour}</option>
            <option value="weekday">{s.weekday}</option>
          </Select>
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer ml-2">
            <Checkbox
              checked={values.compareEnabled || false}
              onCheckedChange={(checked) => update({ compareEnabled: !!checked })}
            />
            {s.compare}
          </label>
          {values.compareEnabled && (
            <Select value={values.compareTimeRange || "7"} onChange={(e) => update({ compareTimeRange: e.target.value })}>
              {TIME_RANGES.map((r) => <option key={r.value} value={r.value}>{s[r.key]}</option>)}
            </Select>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
