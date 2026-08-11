import { RefreshCw } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "../ui/tooltip";
import { cn } from "../lib/utils";

// 配合 useRefreshableList 用的刷新按钮：放在选择器标签旁边，让「我刚在对方站点上改完，
// 回来重新拉一次」变成一次点击，而不是刷新整页。
//
// tooltip 是必填的 string（不是 LocalizedString）：本组件不认识 i18n，文案由调用方用
// T({ en, zh }) 现场翻译好再传进来——CLAUDE.md 要求所有 icon 都带 tooltip，做成必填
// 就没有「忘了写」这个选项。

export interface RefreshButtonProps {
  onClick: () => void;
  /** 取数在途：按钮禁用并转圈，避免用户连点堆叠请求。 */
  busy?: boolean;
  /** 已本地化的提示文案，同时用作 aria-label。 */
  tooltip: string;
  className?: string;
}

export function RefreshButton({ onClick, busy = false, tooltip, className }: RefreshButtonProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={tooltip}
            disabled={busy}
            onClick={onClick}
            className={cn(
              "p-1 rounded text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition-colors",
              className
            )}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
          </button>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
