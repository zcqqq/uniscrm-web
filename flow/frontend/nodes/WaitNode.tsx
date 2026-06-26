import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";

export default function WaitNode({ data, selected }: NodeProps) {
  const duration = data.duration as number;
  const unit = data.unit as string;

  const hasConfig = duration && duration > 0;
  const summary = hasConfig ? `Wait ${duration} ${unit}` : "Configure wait...";

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${
        selected ? "border-blue-500 shadow-md" : "border-sky-300"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-sky-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">⏳</span>
        <span className="font-semibold text-sm text-sky-700">Wait</span>
      </div>
      <p className={`text-xs ${hasConfig ? "text-gray-700" : "text-gray-400 italic"}`}>
        {summary}
      </p>
      <AnalyticsBadges analytics={data._analytics as any} />
      <Handle type="source" position={Position.Right} className="!bg-sky-500 !w-3 !h-3" />
    </div>
  );
}
