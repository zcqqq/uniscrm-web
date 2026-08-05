import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { CONTENT_X_TRIGGER_MODE_LIST_POSTS } from "../../nodeTypeRegistry";
import { nodeLabel } from "../config/nodeTypeLabels";
import { XIcon } from "../../../shared/frontend/ui/icons";
import { Tooltip, TooltipTrigger, TooltipContent } from "../../../shared/frontend/ui/tooltip";
import { conditionSummary } from "../lib/condition-logic";
import { useT } from "../../../shared/frontend/hooks/useT";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";

export default function XContentTriggerNode({ data, selected }: NodeProps) {
  const T = useT();
  const { locale } = useLocale();
  const conditions = (data.conditions as unknown[]) || [];
  const condCount = conditions.filter((c: any) => c?.field).length;
  const mode = data.mode as string;
  const listLabel = T({ en: "List", zh: "名单" });
  const notSelected = T({ en: "(not selected)", zh: "（未选择）" });
  const subtitle = mode === CONTENT_X_TRIGGER_MODE_LIST_POSTS
    ? (locale === "zh"
        ? `${listLabel}：${(data.listName as string) || notSelected}`
        : `${listLabel}: ${(data.listName as string) || notSelected}`)
    : T({ en: "My own posts", zh: "我自己的帖子" });

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${
        selected ? "border-blue-500 shadow-md" : "border-purple-300"
      }`}
    >
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <span><XIcon className="w-4 h-4" /></span>
          </TooltipTrigger>
          <TooltipContent>X</TooltipContent>
        </Tooltip>
        <div>
          <span className="font-semibold text-sm text-purple-700">{T(nodeLabel("xContentTrigger"))}</span>
          <p className="text-xs text-gray-500">{subtitle}</p>
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
