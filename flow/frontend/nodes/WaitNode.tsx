import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { nodeLabel } from "../config/nodeTypeLabels";
import { unitLabel } from "../lib/unit-label";
import { useT } from "../../../shared/frontend/hooks/useT";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";

export default function WaitNode({ data, selected }: NodeProps) {
  const T = useT();
  const { locale } = useLocale();
  const duration = data.duration as number;
  const unit = data.unit as string;

  const hasConfig = duration && duration > 0;
  const summary = hasConfig
    ? `${T({ en: "Wait", zh: "等待" })} ${duration} ${unitLabel(unit, locale)}`
    : T({ en: "Configure wait...", zh: "配置等待…" });

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${
        selected ? "border-blue-500 shadow-md" : "border-indigo-300"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-indigo-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">⏳</span>
        <span className="font-semibold text-sm text-indigo-700">{T(nodeLabel("wait"))}</span>
      </div>
      <p className={`text-xs ${hasConfig ? "text-gray-700" : "text-gray-400 italic"}`}>
        {summary}
      </p>
      <AnalyticsBadges analytics={data._analytics as any} />
      <Handle type="source" position={Position.Right} className="!bg-indigo-500 !w-3 !h-3" />
    </div>
  );
}
