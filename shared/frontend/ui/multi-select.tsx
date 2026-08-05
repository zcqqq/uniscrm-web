import { Popover, PopoverTrigger, PopoverContent } from "./popover";
import { Checkbox } from "./checkbox";
import { Button } from "./button";
import { Tooltip, TooltipTrigger, TooltipContent } from "./tooltip";
import { ChevronDown } from "lucide-react";
import { cn } from "../lib/utils";
import { multiSelectSummary } from "../lib/multi-select-summary";
import { useT } from "../hooks/useT";

export interface MultiSelectOption {
  value: string;
  label: string;
}

// 通用多选下拉：按钮显示已选摘要，Popover 内是可滚动 checkbox 列表。
// 受控组件：选中态完全来自 selectedValues，每次勾选/取消回调 onToggle(value)，
// 由调用方决定写入什么（flow 里是 updateNodeData）。
export function MultiSelect({
  options,
  selectedValues,
  onToggle,
  placeholder,
  tooltip,
  className,
}: {
  options: MultiSelectOption[];
  selectedValues: string[];
  onToggle: (value: string) => void;
  placeholder: string;
  tooltip: string;
  className?: string;
}) {
  const T = useT();
  const labelByValue = new Map(options.map((o) => [o.value, o.label]));
  const selectedLabels = selectedValues.map((v) => labelByValue.get(v) ?? v);
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="outline" className={cn("w-full justify-between text-sm font-normal", className)}>
              <span className="truncate">{multiSelectSummary(selectedLabels, placeholder)}</span>
              <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-64 max-h-64 overflow-y-auto p-2">
        {options.length === 0 ? (
          <p className="px-2 py-1 text-xs italic text-muted-foreground">{T({ en: "No options", zh: "无选项" })}</p>
        ) : (
          options.map((o) => (
            <label
              key={o.value}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
            >
              <Checkbox
                checked={selectedValues.includes(o.value)}
                onCheckedChange={() => onToggle(o.value)}
              />
              <span className="truncate">{o.label}</span>
            </label>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}
