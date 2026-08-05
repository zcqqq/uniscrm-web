import { Handle, Position, type NodeProps } from "@xyflow/react";
import { getChannelTypes } from "../config/trigger-fields";
import AnalyticsBadges from "./AnalyticsBadges";
import { Tooltip, TooltipTrigger, TooltipContent } from "../../../shared/frontend/ui/tooltip";
import { conditionSummary } from "../lib/condition-logic";
import { useT } from "../../../shared/frontend/hooks/useT";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";

export default function TriggerNode({ data, selected }: NodeProps) {
  const T = useT();
  const { locale } = useLocale();
  const channelType = data.channelType as string | undefined;
  const eventType = data.eventType as string | undefined;
  const conditions = (data.conditions as unknown[]) || [];
  const condCount = conditions.filter((c: any) => c?.field).length;

  const ctDef = getChannelTypes(locale).find((ct) => ct.channelType === channelType);
  const evDef = ctDef?.events.find((e) => e.eventType === eventType);

  const triggerWord = T({ en: "Trigger", zh: "触发器" });
  const title = ctDef ? `${ctDef.label} ${triggerWord}` : triggerWord;
  const subtitle = evDef?.label || T({ en: "Select event...", zh: "选择事件…" });
  const Icon = ctDef?.icon;

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${
        selected ? "border-blue-500 shadow-md" : "border-purple-300"
      }`}
    >
      <div className="flex items-center gap-2">
        {Icon ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span><Icon className="w-4 h-4" /></span>
            </TooltipTrigger>
            <TooltipContent>{ctDef!.label}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-lg">⚡</span>
        )}
        <div>
          <span className="font-semibold text-sm text-purple-700">{title}</span>
          {eventType && (
            <p className="text-xs text-gray-500">{subtitle}</p>
          )}
          {!eventType && (
            <p className="text-xs text-gray-400 italic">{T({ en: "Not configured", zh: "未配置" })}</p>
          )}
          {condCount > 0 && (
            <p className="text-xs text-purple-500">{conditionSummary(condCount, data.conditionLogic, locale)}</p>
          )}
        </div>
      </div>
      <AnalyticsBadges analytics={data._analytics as any} />
      <Handle type="source" position={Position.Right} className="!bg-purple-500 !w-3 !h-3" />
    </div>
  );
}
