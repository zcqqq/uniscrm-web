import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";

export default function XContentTriggerNode({ data, selected }: NodeProps) {
  const conditions = (data.conditions as unknown[]) || [];
  const condCount = conditions.filter((c: any) => c?.field).length;
  const mode = data.mode as string;
  const subtitle = mode === "list_posts"
    ? `List: ${(data.listName as string) || "(not selected)"}`
    : "My own posts";

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${
        selected ? "border-blue-500 shadow-md" : "border-purple-300"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-lg">𝕏</span>
        <div>
          <span className="font-semibold text-sm text-purple-700">X Content Trigger</span>
          <p className="text-xs text-gray-500">{subtitle}</p>
          {condCount > 0 && (
            <p className="text-xs text-purple-500">{condCount} condition{condCount > 1 ? "s" : ""}</p>
          )}
        </div>
      </div>
      <AnalyticsBadges analytics={data._analytics as any} />
      <Handle type="source" position={Position.Right} className="!bg-purple-500 !w-3 !h-3" />
    </div>
  );
}
