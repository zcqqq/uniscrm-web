import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";

export default function YouTubeContentTriggerNode({ data, selected }: NodeProps) {
  const conditions = (data.conditions as unknown[]) || [];
  const condCount = conditions.filter((c: any) => c?.field).length;
  const channelName = (data.channelName as string) || "(no channel selected)";

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${
        selected ? "border-blue-500 shadow-md" : "border-red-300"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-lg">▶️</span>
        <div>
          <span className="font-semibold text-sm text-red-700">{NODE_TYPE_REGISTRY.youtubeContentTrigger.label}</span>
          <p className="text-xs text-gray-500">{channelName}</p>
          {condCount > 0 && (
            <p className="text-xs text-red-500">{condCount} condition{condCount > 1 ? "s" : ""}</p>
          )}
        </div>
      </div>
      <AnalyticsBadges analytics={data._analytics as any} />
      <Handle type="source" position={Position.Right} className="!bg-red-500 !w-3 !h-3" />
    </div>
  );
}
