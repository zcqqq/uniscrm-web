import type { LucideIcon } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "../ui/tooltip";

export interface ChartTypeOption {
  value: string;
  icon: LucideIcon;
  tooltip: string;
}

export interface ChartTypeToggleProps {
  value: string;
  onChange: (value: string) => void;
  options: ChartTypeOption[];
}

export function ChartTypeToggle({ value, onChange, options }: ChartTypeToggleProps) {
  return (
    <TooltipProvider>
      <div className="flex items-center gap-0.5 border border-border rounded-md p-0.5 bg-muted/30">
        {options.map((opt) => {
          const Icon = opt.icon;
          const active = value === opt.value;
          return (
            <Tooltip key={opt.value}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={opt.tooltip}
                  onClick={() => onChange(opt.value)}
                  className={`p-1.5 rounded transition-colors ${active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{opt.tooltip}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
