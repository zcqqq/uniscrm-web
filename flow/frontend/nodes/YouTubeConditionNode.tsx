import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { nodeLabel } from "../config/nodeTypeLabels";
import { YouTubeIcon } from "../../../shared/frontend/ui/icons";
import { Tooltip, TooltipTrigger, TooltipContent } from "../../../shared/frontend/ui/tooltip";
import { conditionSummary } from "../lib/condition-logic";
import { useT } from "../../../shared/frontend/hooks/useT";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";

export default function YouTubeConditionNode({ data, selected }: NodeProps) {
  const T = useT();
  const { locale } = useLocale();
  const conditions = (data.conditions as unknown[]) || [];
  const condCount = conditions.filter((c: any) => c?.field).length;

  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[170px] ${selected ? "border-blue-500 shadow-md" : "border-purple-300"}`}>
      <Handle type="target" position={Position.Left} className="!bg-purple-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span><YouTubeIcon className="w-4 h-4" /></span>
          </TooltipTrigger>
          <TooltipContent>YouTube</TooltipContent>
        </Tooltip>
        <span className="font-semibold text-sm text-purple-700">{T(nodeLabel("youtubeCondition"))}</span>
      </div>
      <p className="text-xs text-gray-700">
        {condCount === 0 ? T({ en: "No conditions", zh: "无条件" }) : conditionSummary(condCount, data.conditionLogic, locale)}
      </p>
      <AnalyticsBadges analytics={data._analytics as any} />
      <span className="absolute right-1 text-[10px] text-green-600" style={{ top: "25%", transform: "translateY(-50%)" }}>{T({ en: "True", zh: "真" })}</span>
      <span className="absolute right-1 text-[10px] text-gray-500" style={{ top: "50%", transform: "translateY(-50%)" }}>{T({ en: "False", zh: "假" })}</span>
      <span className="absolute right-1 text-[10px] text-red-500" style={{ top: "75%", transform: "translateY(-50%)" }}>{T({ en: "Failed", zh: "失败" })}</span>
      <Handle type="source" position={Position.Right} id="true" className="!bg-green-500 !w-2.5 !h-2.5" style={{ top: "25%" }} />
      <Handle type="source" position={Position.Right} id="false" className="!bg-gray-400 !w-2.5 !h-2.5" style={{ top: "50%" }} />
      <Handle type="source" position={Position.Right} id="failed" className="!bg-red-400 !w-2.5 !h-2.5" style={{ top: "75%" }} />
    </div>
  );
}
