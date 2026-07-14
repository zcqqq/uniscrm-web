import { useState } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "../ui/popover";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import type { Locale } from "../../../metadata/locale";

export type BucketMode = "discrete" | "default" | "custom";

interface BucketModePopoverProps {
  mode: BucketMode;
  buckets: string; // comma-separated ascending boundary points, e.g. "100,1000"
  onChange: (next: { mode: BucketMode; buckets: string }) => void;
  locale?: Locale;
}

const UI = {
  en: {
    configure: "Configure",
    title: "Choose how to group",
    discrete: "Use discrete numbers (no interval)",
    default: "Default interval",
    custom: "Use custom interval",
    addInterval: "+ Add interval",
    confirm: "Confirm",
  },
  zh: {
    configure: "配置",
    title: "选择如何分组",
    discrete: "使用离散数字(没有区间)",
    default: "默认区间",
    custom: "使用自定义区间",
    addInterval: "+ 添加区间",
    confirm: "确定",
  },
};

function parseBoundaries(buckets: string): number[] {
  return buckets.split(",").map(Number).filter((n) => !isNaN(n));
}

export function BucketModePopover({ mode, buckets, onChange, locale = "en" }: BucketModePopoverProps) {
  const s = UI[locale];
  const [open, setOpen] = useState(false);
  const [draftMode, setDraftMode] = useState<BucketMode>(mode);
  const [draftBoundaries, setDraftBoundaries] = useState<number[]>(parseBoundaries(buckets));

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setDraftMode(mode);
      setDraftBoundaries(parseBoundaries(buckets));
    }
    setOpen(next);
  };

  const setBoundaryAt = (idx: number, value: string) => {
    const n = Number(value);
    const next = [...draftBoundaries];
    if (value === "" || isNaN(n)) {
      next.splice(idx, 1);
    } else {
      next[idx] = n;
    }
    setDraftBoundaries(next);
  };

  const addInterval = () => setDraftBoundaries([...draftBoundaries, draftBoundaries[draftBoundaries.length - 1] ?? 0]);
  const removeInterval = (idx: number) => setDraftBoundaries(draftBoundaries.filter((_, i) => i !== idx));

  const confirm = () => {
    const sorted = [...draftBoundaries].sort((a, b) => a - b);
    onChange({ mode: draftMode, buckets: draftMode === "custom" ? sorted.join(",") : buckets });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" className="text-xs text-primary hover:underline ml-2">
          ⚙️ {s.configure}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium">{s.title}</span>
        </div>
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" checked={draftMode === "discrete"} onChange={() => setDraftMode("discrete")} />
            {s.discrete}
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" checked={draftMode === "default"} onChange={() => setDraftMode("default")} />
            {s.default}
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" checked={draftMode === "custom"} onChange={() => setDraftMode("custom")} />
            {s.custom}
          </label>
        </div>
        {draftMode === "custom" && (
          <div className="mt-3 space-y-2">
            {Array.from({ length: draftBoundaries.length + 1 }).map((_, rowIdx) => {
              const isFirst = rowIdx === 0;
              const isLast = rowIdx === draftBoundaries.length;
              const lowerLabel = isFirst ? "-∞" : String(draftBoundaries[rowIdx - 1]);
              return (
                <div key={rowIdx} className="flex items-center gap-1 text-xs">
                  <span className="text-muted-foreground w-10 shrink-0">区间{rowIdx + 1}:</span>
                  <span>[</span>
                  <span className="w-14 text-center">{lowerLabel}</span>
                  <span>,</span>
                  {isLast ? (
                    <span className="w-16 text-center">+∞</span>
                  ) : (
                    <Input
                      type="number"
                      value={draftBoundaries[rowIdx] ?? ""}
                      onChange={(e) => setBoundaryAt(rowIdx, e.target.value)}
                      className="h-6 w-16 text-xs"
                    />
                  )}
                  <span>)</span>
                  {!isFirst && !isLast && (
                    <button type="button" className="text-muted-foreground hover:text-destructive ml-1" onClick={() => removeInterval(rowIdx - 1)}>
                      ✕
                    </button>
                  )}
                </div>
              );
            })}
            <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={addInterval}>
              {s.addInterval}
            </Button>
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <Button size="sm" onClick={confirm}>{s.confirm}</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
