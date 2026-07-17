import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";

export default function AbSplitNode({ data, selected }: NodeProps) {
  const mode = data.mode as string;
  const percentA = data.percentA as number || 50;
  const summary = mode === "random" ? `${percentA}% / ${100 - percentA}%` : mode === "condition" ? "Condition split" : "Configure...";

  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${selected ? "border-blue-500 shadow-md" : "border-indigo-300"}`}>
      <Handle type="target" position={Position.Left} className="!bg-indigo-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <svg className="w-4 h-4 text-indigo-600" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" /></svg>
        <span className="font-semibold text-sm text-indigo-700">{NODE_TYPE_REGISTRY.abSplit.label}</span>
      </div>
      <p className={`text-xs ${mode ? "text-gray-700" : "text-gray-400 italic"}`}>{summary}</p>
      <AnalyticsBadges analytics={data._analytics as any} />
      <span className="absolute right-1 text-[10px] text-indigo-600" style={{ top: "35%", transform: "translateY(-50%)" }}>A</span>
      <span className="absolute right-1 text-[10px] text-indigo-400" style={{ top: "65%", transform: "translateY(-50%)" }}>B</span>
      <Handle type="source" position={Position.Right} id="a" className="!bg-indigo-600 !w-2.5 !h-2.5" style={{ top: "35%" }} />
      <Handle type="source" position={Position.Right} id="b" className="!bg-indigo-400 !w-2.5 !h-2.5" style={{ top: "65%" }} />
    </div>
  );
}
