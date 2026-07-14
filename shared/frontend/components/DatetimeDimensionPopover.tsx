import { useState, useEffect } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "../ui/popover";
import { Button } from "../ui/button";
import type { Locale } from "../../../metadata/locale";
import { suggestGranularity } from "./datetimeGranularity";
import type { DatetimeGranularity } from "./datetimeGranularity";

// Re-exported so consumers (e.g. Task 5's ReportConfig.tsx) can keep
// importing DatetimeGranularity/suggestGranularity from this component file;
// the actual implementation lives in ./datetimeGranularity (see that file's
// comment for why it's split out).
export type { DatetimeGranularity };
export { suggestGranularity };

interface DatetimeDimensionPopoverProps {
  dimension: string;
  mode: string; // "user" | "content" | "event"
  value?: DatetimeGranularity;
  onChange: (next: DatetimeGranularity) => void;
  // Injected rather than imported directly, so this shared component never
  // depends on a specific module's API client (analytics/frontend/lib/api.ts).
  fetchRange: (mode: string, dimension: string) => Promise<{ min: string | null; max: string | null }>;
  locale?: Locale;
}

const UI = {
  en: {
    configure: "Configure",
    title: "Choose granularity",
    none: "No aggregation",
    hour: "Hour",
    day: "Day",
    week: "Week",
    month: "Month",
    quarter: "Quarter",
    confirm: "Confirm",
  },
  zh: {
    configure: "配置",
    title: "选择汇总粒度",
    none: "不汇总",
    hour: "小时",
    day: "天",
    week: "周",
    month: "月",
    quarter: "季度",
    confirm: "确定",
  },
};

const OPTIONS: DatetimeGranularity[] = ["none", "hour", "day", "week", "month", "quarter"];

export function DatetimeDimensionPopover({ dimension, mode, value, onChange, fetchRange, locale = "en" }: DatetimeDimensionPopoverProps) {
  const s = UI[locale];
  const [open, setOpen] = useState(false);
  const [draftValue, setDraftValue] = useState<DatetimeGranularity>(value || "none");
  const [range, setRange] = useState<{ min: string | null; max: string | null } | null>(null);

  // Eagerly prefetch the field's range as soon as it's selected as the
  // dimension (not gated on the popover being open), so the suggestion is
  // usually already available by the time the user opens Configure.
  useEffect(() => {
    setRange(null);
    fetchRange(mode, dimension).then(setRange).catch(() => setRange(null));
  }, [mode, dimension, fetchRange]);

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setDraftValue(value || (range ? suggestGranularity(range.min, range.max) : "none"));
    }
    setOpen(next);
  };

  const confirm = () => {
    onChange(draftValue);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" className="text-xs text-primary hover:underline ml-2">
          ⚙️ {s.configure}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium">{s.title}</span>
        </div>
        <div className="space-y-2 text-sm">
          {OPTIONS.map((opt) => (
            <label key={opt} className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={draftValue === opt} onChange={() => setDraftValue(opt)} />
              {s[opt]}
            </label>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <Button size="sm" onClick={confirm}>{s.confirm}</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
