import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { nodeLabel } from "../config/nodeTypeLabels";
import { YouTubeIcon } from "../../../shared/frontend/ui/icons";
import { Tooltip, TooltipTrigger, TooltipContent } from "../../../shared/frontend/ui/tooltip";
import { conditionSummary } from "../lib/condition-logic";
import { subscriptionSummary } from "../lib/subscription-summary";
import { resolveYouTubeSubscriptions } from "../../nodeTypeRegistry";
import { useT } from "../../../shared/frontend/hooks/useT";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";

export default function YouTubeContentTriggerNode({ data, selected }: NodeProps) {
  const T = useT();
  const { locale } = useLocale();
  const conditions = (data.conditions as unknown[]) || [];
  const condCount = conditions.filter((c: any) => c?.field).length;
  const channelName = subscriptionSummary(resolveYouTubeSubscriptions(data as Record<string, unknown>), locale);

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${
        selected ? "border-blue-500 shadow-md" : "border-red-300"
      }`}
    >
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <span><YouTubeIcon className="w-4 h-4" /></span>
          </TooltipTrigger>
          <TooltipContent>YouTube</TooltipContent>
        </Tooltip>
        <div>
          <span className="font-semibold text-sm text-red-700">{T(nodeLabel("youtubeContentTrigger"))}</span>
          <p className="text-xs text-gray-500">{channelName}</p>
          {condCount > 0 && (
            <p className="text-xs text-red-500">{conditionSummary(condCount, data.conditionLogic, locale)}</p>
          )}
        </div>
      </div>
      <AnalyticsBadges analytics={data._analytics as any} />
      <Handle type="source" position={Position.Right} className="!bg-red-500 !w-3 !h-3" />
    </div>
  );
}
