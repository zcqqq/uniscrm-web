import { useState } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "../ui/popover";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { t } from "../../../metadata/locale";
import type { Locale } from "../../../metadata/locale";
import type { LocalizedString } from "../../../metadata/dataTypes";

export type BucketMode = "discrete" | "default" | "custom";

interface IntDimensionPopoverProps {
  mode: BucketMode;
  buckets: string; // comma-separated ascending boundary points, e.g. "100,1000"
  onChange: (next: { mode: BucketMode; buckets: string }) => void;
  locale?: Locale;
}

const UI: Record<string, LocalizedString> = {
  configure: { en: "Configure", zh: "配置" },
  title: { en: "Choose how to group", zh: "选择如何分组" },
  discrete: { en: "Use discrete numbers (no interval)", zh: "使用离散数字(没有区间)" },
  default: { en: "Default interval", zh: "默认区间" },
  custom: { en: "Use custom interval", zh: "使用自定义区间" },
  addInterval: { en: "+ Add interval", zh: "+ 添加区间" },
  confirm: { en: "Confirm", zh: "确定" },
  // "{n}" 占位符在渲染时替换成桶序号 —— 与 flow/frontend/config/nodeTypeLabels.ts 的
  // nodeDescription() 是同一套模式。
  bucket: { en: "Bucket {n}:", zh: "区间{n}:" },
};

function parseBoundaries(buckets: string): number[] {
  return buckets.split(",").map(Number).filter((n) => !isNaN(n));
}

export function IntDimensionPopover({ mode, buckets, onChange, locale = "en" }: IntDimensionPopoverProps) {
  const s = (key: keyof typeof UI) => t(UI[key], locale);
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
    onChange({ mode: draftMode, buckets: draftMode === "custom" ? sorted.join(",") : "" });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" className="text-xs text-primary hover:underline ml-2">
          ⚙️ {s("configure")}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium">{s("title")}</span>
        </div>
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" checked={draftMode === "discrete"} onChange={() => setDraftMode("discrete")} />
            {s("discrete")}
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" checked={draftMode === "default"} onChange={() => setDraftMode("default")} />
            {s("default")}
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" checked={draftMode === "custom"} onChange={() => setDraftMode("custom")} />
            {s("custom")}
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
                  <span className="text-muted-foreground w-10 shrink-0">{s("bucket").replace("{n}", String(rowIdx + 1))}</span>
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
              {s("addInterval")}
            </Button>
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <Button size="sm" onClick={confirm}>{s("confirm")}</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
