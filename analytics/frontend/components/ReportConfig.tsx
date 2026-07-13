import { useState } from "react";
import { EventMetadata_X, PROPS_X } from "../../../metadata/x";
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
const propsByEntity = (entity: "user" | "content") =>
  PROPS_X.filter((p) => p.isInsight && p.entity?.includes(entity));

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
  mode?: "event" | "interval" | "user" | "content" | "funnel";
  eventType: string;
  measure: "count" | "users" | "avg" | "sum";
  measureField?: string;
  eventTypeA?: string;
  eventTypeB?: string;
  dimension: string;
  buckets?: string;
  timeRange: string;
  granularity: "total" | "day" | "week" | "month" | "hour" | "weekday";
  compareEnabled?: boolean;
  compareTimeRange?: string;
  filters?: FilterCondition[];
  funnelSteps?: string[];
  windowValue?: number;
  windowUnit?: "day" | "hour";
}

interface ReportConfigProps {
  values: ReportConfigValues;
  onChange: (values: ReportConfigValues) => void;
  mode?: "event" | "interval" | "user" | "content" | "funnel";
}

export function ReportConfig({ values, onChange, mode: modeProp }: ReportConfigProps) {
  const { locale } = useLocale();
  const s = UI[locale];
  const mode = modeProp || values.mode || "event";
  const entityProps = propsByEntity(mode === "content" ? "content" : "user");
  const numericEntityProps = entityProps.filter((p) => p.dataType === "INT");
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
        {/* Funnel mode — steps + window */}
        {mode === "funnel" && (
          <div className="space-y-3 mb-4">
            <Label className="block">{locale === "zh" ? "漏斗步骤" : "Funnel Steps"}</Label>
            {(values.funnelSteps || ["", ""]).map((step, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center shrink-0">{i + 1}</span>
                <Select value={step} onChange={(e) => {
                  const steps = [...(values.funnelSteps || ["", ""])];
                  steps[i] = e.target.value;
                  update({ funnelSteps: steps });
                }} className="flex-1">
                  <option value="">{s.selectEvent}</option>
                  {TRIGGER_EVENTS.map((ev) => <option key={ev.eventType} value={ev.eventType}>{t(ev.label, locale)}</option>)}
                </Select>
                {(values.funnelSteps || []).length > 2 && (
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={() => {
                    const steps = (values.funnelSteps || []).filter((_, j) => j !== i);
                    update({ funnelSteps: steps });
                  }}>✕</Button>
                )}
              </div>
            ))}
            {(values.funnelSteps || []).length < 10 && (
              <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => update({ funnelSteps: [...(values.funnelSteps || ["", ""]), ""] })}>
                + {locale === "zh" ? "添加步骤" : "Add step"}
              </Button>
            )}
            <div className="flex items-center gap-2 mt-3">
              <Label className="text-sm text-muted-foreground shrink-0">{locale === "zh" ? "窗口期" : "Window"}:</Label>
              <Input type="number" value={values.windowValue ?? 7} onChange={(e) => update({ windowValue: parseInt(e.target.value) || 7 })} className="h-7 w-16 text-xs" min={1} />
              <Select value={values.windowUnit || "day"} onChange={(e) => update({ windowUnit: e.target.value as any })} className="h-7 text-xs">
                <option value="day">{locale === "zh" ? "天" : "days"}</option>
                <option value="hour">{locale === "zh" ? "小时" : "hours"}</option>
              </Select>
            </div>
          </div>
        )}

        {/* Measure + Dimension */}
        {mode !== "funnel" && <div className="flex gap-8 flex-wrap">
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
            ) : mode === "user" || mode === "content" ? (
              <>
                <Label className="mb-2 block">{s.measure}</Label>
                <div className="flex items-center gap-2 flex-wrap">
                  <Select value={values.measure} onChange={(e) => update({ measure: e.target.value as any, measureField: e.target.value !== "count" ? (values.measureField || numericEntityProps[0]?.propId || "") : undefined })}>
                    <option value="count">{mode === "content" ? (locale === "zh" ? "内容数" : "Content count") : (locale === "zh" ? "用户数" : "User count")}</option>
                    <option value="avg">{locale === "zh" ? "平均值" : "Average"}</option>
                    <option value="sum">{locale === "zh" ? "总和" : "Sum"}</option>
                  </Select>
                  {(values.measure === "avg" || values.measure === "sum") && (
                    <>
                      <span className="text-muted-foreground text-sm">→</span>
                      <Select value={values.measureField || ""} onChange={(e) => update({ measureField: e.target.value })}>
                        {numericEntityProps.map((p) => <option key={p.propId} value={p.propId}>{t(p.label, locale)}</option>)}
                      </Select>
                    </>
                  )}
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
              {mode === "user" || mode === "content" ? (
                <Select value={values.dimension} onChange={(e) => update({ dimension: e.target.value, buckets: "" })}>
                  <option value="">{s.noGroup}</option>
                  {entityProps.map((p) => <option key={p.propId} value={p.propId}>{t(p.label, locale)}</option>)}
                </Select>
              ) : (
                <SelectProps
                  eventType={mode === "interval" ? (values.eventTypeA || "") : values.eventType}
                  value={values.dimension}
                  onChange={(v) => update({ dimension: v })}
                  locale={locale}
                  placeholder={s.noGroup}
                />
              )}
            </div>
            {values.dimension && entityProps.find(p => p.propId === values.dimension)?.dataType === "INT" && (
              <div className="mt-2">
                <Input
                  type="text"
                  value={values.buckets || ""}
                  onChange={(e) => update({ buckets: e.target.value })}
                  placeholder={locale === "zh" ? "分档边界 (逗号分隔, 如 100,1000,10000)" : "Bucket boundaries (comma-separated, e.g. 100,1000,10000)"}
                  className="text-xs h-7"
                />
              </div>
            )}
          </div>
        </div>}

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

        {/* Time range + Granularity + Compare (not for user/content snapshot modes) */}
        {mode !== "user" && mode !== "content" && <div className="flex items-center gap-3 mt-4 flex-wrap">
          <Select value={values.timeRange} onChange={(e) => update({ timeRange: e.target.value })}>
            {TIME_RANGES.map((r) => <option key={r.value} value={r.value}>{s[r.key]}</option>)}
          </Select>
          {mode !== "funnel" && <Select value={values.granularity} onChange={(e) => update({ granularity: e.target.value as any })}>
            <option value="total">{s.total}</option>
            <option value="day">{s.day}</option>
            <option value="week">{s.week}</option>
            <option value="month">{s.month}</option>
            <option value="hour">{s.hour}</option>
            <option value="weekday">{s.weekday}</option>
          </Select>}
          {mode !== "funnel" && <>
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
          </>}
        </div>}
      </CardContent>
    </Card>
  );
}
