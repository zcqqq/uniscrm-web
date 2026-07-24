import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";

const OPERATION_DEFAULTS: Record<string, { operator: string; threshold: number; label: string }> = {
  "check-face": { operator: "<=", threshold: 0.2, label: "Face ratio" },
  "check-orientation": { operator: ">", threshold: 1, label: "Aspect ratio" },
};

export default function VideoConditionNode({ data, selected }: NodeProps) {
  const operation = (data.operation as string) || "check-face";
  const defaults = OPERATION_DEFAULTS[operation] || OPERATION_DEFAULTS["check-face"];
  const operator = (data.operator as string) || defaults.operator;
  const threshold = data.threshold === undefined || data.threshold === "" ? defaults.threshold : data.threshold;
  const summary = `${defaults.label} ${operator} ${threshold}`;

  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[170px] ${selected ? "border-blue-500 shadow-md" : "border-purple-300"}`}>
      <Handle type="target" position={Position.Left} className="!bg-purple-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <span className="text-base leading-none">👁️</span>
        <span className="font-semibold text-sm text-purple-700">{NODE_TYPE_REGISTRY.videoCondition.label}</span>
      </div>
      <p className="text-xs text-gray-700">{summary}</p>
      <AnalyticsBadges analytics={data._analytics as any} />
      <span className="absolute right-1 text-[10px] text-green-600" style={{ top: "25%", transform: "translateY(-50%)" }}>True</span>
      <span className="absolute right-1 text-[10px] text-gray-500" style={{ top: "50%", transform: "translateY(-50%)" }}>False</span>
      <span className="absolute right-1 text-[10px] text-red-500" style={{ top: "75%", transform: "translateY(-50%)" }}>Failed</span>
      <Handle type="source" position={Position.Right} id="true" className="!bg-green-500 !w-2.5 !h-2.5" style={{ top: "25%" }} />
      <Handle type="source" position={Position.Right} id="false" className="!bg-gray-400 !w-2.5 !h-2.5" style={{ top: "50%" }} />
      <Handle type="source" position={Position.Right} id="failed" className="!bg-red-400 !w-2.5 !h-2.5" style={{ top: "75%" }} />
    </div>
  );
}
