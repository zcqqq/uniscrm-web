import { EventMetadata_X } from "../../../metadata/x";
import { PROPS } from "../../../metadata/props";
import type { PropDefinition, LocalizedString } from "../../../metadata/dataTypes";
import { t } from "../../../metadata/locale";
import { SelectProps } from "../../../shared/frontend/components/SelectProps";
import { IntDimensionPopover, type BucketMode } from "../../../shared/frontend/components/IntDimensionPopover";
import { DatetimeDimensionPopover, type DatetimeGranularity } from "../../../shared/frontend/components/DatetimeDimensionPopover";
import { getDimensionRange } from "../lib/api";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";
import { useT } from "../../../shared/frontend/hooks/useT";
import { Select } from "../../../shared/frontend/ui/select";
import { Input } from "../../../shared/frontend/ui/input";
import { Card, CardContent } from "../../../shared/frontend/ui/card";
import { Label } from "../../../shared/frontend/ui/label";
import { Button } from "../../../shared/frontend/ui/button";
import { Checkbox } from "../../../shared/frontend/ui/checkbox";

const TRIGGER_EVENTS = EventMetadata_X.filter((e) => e.flowType !== "action");
const propsByEntity = (entity: "user" | "content") =>
  PROPS.filter((p) => p.isInsight && p.entity?.includes(entity));
const eventPropsFor = (eventType: string): PropDefinition[] => {
  const meta = EventMetadata_X.find((e) => e.eventType === eventType);
  const eventPropIds = meta?.eventProps.map((p) => p.propId) || [];
  return eventPropIds.map((id) => PROPS.find((p) => p.propId === id)).filter((p): p is PropDefinition => !!p);
};

const UI = {
  measure: { en: "Measure", zh: "选择指标" },
  dimension: { en: "Dimension", zh: "选择维度" },
  selectEvent: { en: "Select event...", zh: "选择事件…" },
  totalCount: { en: "Total count", zh: "总次数" },
  uniqueUsers: { en: "Unique users", zh: "总人数" },
  perUserAvg: { en: "Per-user avg", zh: "人均次数" },
  noGroup: { en: "No grouping", zh: "不分组" },
  viewBy: { en: "View by", zh: "按" },
  today: { en: "Today", zh: "今天" },
  yesterday: { en: "Yesterday", zh: "昨天" },
  thisWeek: { en: "This week", zh: "本周" },
  lastWeek: { en: "Last week", zh: "上周" },
  thisMonth: { en: "This month", zh: "本月" },
  lastMonth: { en: "Last month", zh: "上月" },
  last7d: { en: "Last 7 days", zh: "过去7天" },
  last14d: { en: "Last 14 days", zh: "过去14天" },
  last30d: { en: "Last 30 days", zh: "过去30天" },
  last90d: { en: "Last 90 days", zh: "过去90天" },
  last180d: { en: "Last 180 days", zh: "过去180天" },
  last360d: { en: "Last 360 days", zh: "过去360天" },
  total: { en: "Total", zh: "按总体" },
  day: { en: "Day", zh: "按日" },
  week: { en: "Week", zh: "按周" },
  month: { en: "Month", zh: "按月" },
  hour: { en: "Hour", zh: "按小时" },
  weekday: { en: "Weekday", zh: "按周几" },
  compare: { en: "Compare period", zh: "对比时间" },
  filter: { en: "Filter", zh: "筛选条件" },
  addFilter: { en: "Add filter", zh: "添加条件" },
  between: { en: "between", zh: "介于" },
  hasValue: { en: "has value", zh: "有值" },
  noValue: { en: "no value", zh: "无值" },
} satisfies Record<string, LocalizedString>;

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
  dimensionBucketMode?: BucketMode;
  buckets?: string;
  dimensionDateGranularity?: DatetimeGranularity;
  sortColumn?: string;
  sortDirection?: "asc" | "desc";
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
  const T = useT();
  const mode = modeProp || values.mode || "event";
  const entityProps = propsByEntity(mode === "content" ? "content" : "user");
  const numericEntityProps = entityProps.filter((p) => p.dataType === "INT");
  const selectedDimensionIsInt = PROPS.find((p) => p.propId === values.dimension)?.dataType === "INT";
  const selectedDimensionIsDatetime = PROPS.find((p) => p.propId === values.dimension)?.dataType === "DATETIME";

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

  const filterFieldOptions: PropDefinition[] =
    mode === "user" || mode === "content" ? entityProps
    : mode === "interval" ? eventPropsFor(values.eventTypeA || "")
    : mode === "funnel" ? eventPropsFor((values.funnelSteps || [])[0] || "")
    : eventPropsFor(values.eventType);

  return (
    <Card className="mb-5">
      <CardContent className="p-5">
        {/* Funnel mode — steps + window */}
        {mode === "funnel" && (
          <div className="space-y-3 mb-4">
            <Label className="block">{T({ en: "Funnel Steps", zh: "漏斗步骤" })}</Label>
            {(values.funnelSteps || ["", ""]).map((step, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center shrink-0">{i + 1}</span>
                <Select value={step} onChange={(e) => {
                  const steps = [...(values.funnelSteps || ["", ""])];
                  steps[i] = e.target.value;
                  update({ funnelSteps: steps });
                }} className="flex-1">
                  <option value="">{T(UI.selectEvent)}</option>
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
                + {T({ en: "Add step", zh: "添加步骤" })}
              </Button>
            )}
            <div className="flex items-center gap-2 mt-3">
              <Label className="text-sm text-muted-foreground shrink-0">{T({ en: "Window", zh: "窗口期" })}:</Label>
              <Input type="number" value={values.windowValue ?? 7} onChange={(e) => update({ windowValue: parseInt(e.target.value) || 7 })} className="h-7 w-16 text-xs" min={1} />
              <Select value={values.windowUnit || "day"} onChange={(e) => update({ windowUnit: e.target.value as any })} className="h-7 text-xs">
                <option value="day">{T({ en: "days", zh: "天" })}</option>
                <option value="hour">{T({ en: "hours", zh: "小时" })}</option>
              </Select>
            </div>
          </div>
        )}

        {/* Measure + Dimension */}
        {mode !== "funnel" && <div className="flex gap-8 flex-wrap">
          <div className="flex-1 min-w-[280px]">
            {mode === "interval" ? (
              <>
                <Label className="mb-2 block">{T({ en: "Define Events", zh: "定义行为事件" })}</Label>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-16">{T({ en: "Initial", zh: "初始行为" })}</span>
                    <Select value={values.eventTypeA || ""} onChange={(e) => update({ eventTypeA: e.target.value })}>
                      <option value="">{T(UI.selectEvent)}</option>
                      {TRIGGER_EVENTS.map((e) => <option key={e.eventType} value={e.eventType}>{t(e.label, locale)}</option>)}
                    </Select>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-16">{T({ en: "Follow-up", zh: "结束行为" })}</span>
                    <Select value={values.eventTypeB || ""} onChange={(e) => update({ eventTypeB: e.target.value })}>
                      <option value="">{T(UI.selectEvent)}</option>
                      {TRIGGER_EVENTS.map((e) => <option key={e.eventType} value={e.eventType}>{t(e.label, locale)}</option>)}
                    </Select>
                  </div>
                </div>
              </>
            ) : mode === "user" || mode === "content" ? (
              <>
                <Label className="mb-2 block">{T(UI.measure)}</Label>
                <div className="flex items-center gap-2 flex-wrap">
                  <Select value={values.measure} onChange={(e) => update({ measure: e.target.value as any, measureField: e.target.value !== "count" ? (values.measureField || numericEntityProps[0]?.propId || "") : undefined })}>
                    <option value="count">{mode === "content" ? (T({ en: "Content count", zh: "内容数" })) : (T({ en: "User count", zh: "用户数" }))}</option>
                    <option value="avg">{T({ en: "Average", zh: "平均值" })}</option>
                    <option value="sum">{T({ en: "Sum", zh: "总和" })}</option>
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
                <Label className="mb-2 block">{T(UI.measure)}</Label>
                <div className="flex items-center gap-2 flex-wrap">
                  <Select value={values.eventType} onChange={(e) => update({ eventType: e.target.value })}>
                    <option value="">{T(UI.selectEvent)}</option>
                    {TRIGGER_EVENTS.map((e) => <option key={e.eventType} value={e.eventType}>{t(e.label, locale)}</option>)}
                  </Select>
                  <span className="text-muted-foreground text-sm">→</span>
                  <Select value={values.measure} onChange={(e) => update({ measure: e.target.value as any })}>
                    <option value="count">{T(UI.totalCount)}</option>
                    <option value="users">{T(UI.uniqueUsers)}</option>
                    <option value="avg">{T(UI.perUserAvg)}</option>
                  </Select>
                </div>
              </>
            )}
          </div>
          <div className="flex-1 min-w-[200px]">
            <Label className="mb-2 block">{T(UI.dimension)}</Label>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">{T(UI.viewBy)}</span>
              {mode === "user" || mode === "content" ? (
                <SelectProps
                  options={entityProps}
                  value={values.dimension}
                  onChange={(v) => update({ dimension: v, buckets: "", dimensionBucketMode: undefined, dimensionDateGranularity: undefined })}
                  locale={locale}
                  placeholder={T(UI.noGroup)}
                />
              ) : (
                <SelectProps
                  options={eventPropsFor(mode === "interval" ? (values.eventTypeA || "") : values.eventType)}
                  value={values.dimension}
                  onChange={(v) => update({ dimension: v, buckets: "", dimensionBucketMode: undefined, dimensionDateGranularity: undefined })}
                  locale={locale}
                  placeholder={T(UI.noGroup)}
                />
              )}
              {values.dimension && selectedDimensionIsInt && mode !== "interval" && (
                <IntDimensionPopover
                  mode={values.dimensionBucketMode || (values.buckets ? "custom" : "discrete")}
                  buckets={values.buckets || ""}
                  onChange={({ mode, buckets }) => update({ dimensionBucketMode: mode, buckets })}
                  locale={locale}
                />
              )}
              {values.dimension && selectedDimensionIsDatetime && mode !== "interval" && (
                <DatetimeDimensionPopover
                  dimension={values.dimension}
                  mode={mode}
                  value={values.dimensionDateGranularity}
                  onChange={(v) => update({ dimensionDateGranularity: v })}
                  fetchRange={getDimensionRange}
                  locale={locale}
                />
              )}
            </div>
          </div>
        </div>}

        {/* Filter conditions */}
        {(values.filters || []).length > 0 && (
          <div className="mt-4 space-y-2">
            {(values.filters || []).map((f, i) => (
              <div key={i} className="flex items-center gap-2 flex-wrap">
                <SelectProps
                  options={filterFieldOptions}
                  value={f.field}
                  onChange={(v) => updateFilter(i, { field: v })}
                  locale={locale}
                  placeholder={T({ en: "Select field", zh: "选择属性" })}
                />
                <Select value={f.operator} onChange={(e) => updateFilter(i, { operator: e.target.value })} className="h-7 text-xs">
                  {OPERATORS.map((op) => <option key={op} value={op}>{op === "between" ? T(UI.between) : op === "has value" ? T(UI.hasValue) : op === "no value" ? T(UI.noValue) : op}</option>)}
                </Select>
                {f.operator !== "has value" && f.operator !== "no value" && (
                  <Input type="text" value={f.value} onChange={(e) => updateFilter(i, { value: e.target.value })} className="h-7 w-20 text-xs" placeholder={T({ en: "value", zh: "值" })} />
                )}
                {f.operator === "between" && (
                  <Input type="text" value={f.value2 || ""} onChange={(e) => updateFilter(i, { value2: e.target.value })} className="h-7 w-20 text-xs" placeholder={T({ en: "max", zh: "最大值" })} />
                )}
                <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={() => removeFilter(i)}>✕</Button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3">
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={addFilter}>
            + {T(UI.addFilter)}
          </Button>
        </div>

        {/* Time range + Granularity + Compare (not for user/content snapshot modes) */}
        {mode !== "user" && mode !== "content" && <div className="flex items-center gap-3 mt-4 flex-wrap">
          <Select value={values.timeRange} onChange={(e) => update({ timeRange: e.target.value })}>
            {TIME_RANGES.map((r) => <option key={r.value} value={r.value}>{T(UI[r.key])}</option>)}
          </Select>
          {mode !== "funnel" && <Select value={values.granularity} onChange={(e) => update({ granularity: e.target.value as any })}>
            <option value="total">{T(UI.total)}</option>
            <option value="day">{T(UI.day)}</option>
            <option value="week">{T(UI.week)}</option>
            <option value="month">{T(UI.month)}</option>
            <option value="hour">{T(UI.hour)}</option>
            <option value="weekday">{T(UI.weekday)}</option>
          </Select>}
          {mode !== "funnel" && <>
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer ml-2">
              <Checkbox
                checked={values.compareEnabled || false}
                onCheckedChange={(checked) => update({ compareEnabled: !!checked })}
              />
              {T(UI.compare)}
            </label>
            {values.compareEnabled && (
              <Select value={values.compareTimeRange || "7"} onChange={(e) => update({ compareTimeRange: e.target.value })}>
                {TIME_RANGES.map((r) => <option key={r.value} value={r.value}>{T(UI[r.key])}</option>)}
              </Select>
            )}
          </>}
        </div>}
      </CardContent>
    </Card>
  );
}
