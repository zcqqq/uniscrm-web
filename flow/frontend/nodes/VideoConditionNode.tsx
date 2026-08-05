import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { nodeLabel } from "../config/nodeTypeLabels";
import { useT } from "../../../shared/frontend/hooks/useT";
import type { LocalizedString } from "../../../metadata/dataTypes";

const OPERATION_DEFAULTS: Record<string, { operator: string; threshold: number; label: LocalizedString }> = {
  "check-face": { operator: "<=", threshold: 0.2, label: { en: "Face ratio", zh: "人脸占比" } },
  "check-orientation": { operator: ">", threshold: 1, label: { en: "Aspect ratio", zh: "宽高比" } },
};

export default function VideoConditionNode({ data, selected }: NodeProps) {
  const T = useT();
  const operation = (data.operation as string) || "check-face";
  const defaults = OPERATION_DEFAULTS[operation] || OPERATION_DEFAULTS["check-face"];
  const operator = (data.operator as string) || defaults.operator;
  const threshold = data.threshold === undefined || data.threshold === "" ? defaults.threshold : data.threshold;
  const summary = `${T(defaults.label)} ${operator} ${threshold}`;

  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[170px] ${selected ? "border-blue-500 shadow-md" : "border-purple-300"}`}>
      <Handle type="target" position={Position.Left} className="!bg-purple-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <span className="text-base leading-none">👁️</span>
        <span className="font-semibold text-sm text-purple-700">{T(nodeLabel("videoCondition"))}</span>
      </div>
      <p className="text-xs text-gray-700">{summary}</p>
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
