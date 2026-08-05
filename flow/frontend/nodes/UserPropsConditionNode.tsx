import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { nodeLabel } from "../config/nodeTypeLabels";
import { useT } from "../../../shared/frontend/hooks/useT";
import { C } from "../../../shared/frontend/i18n-common";

export default function UserPropsConditionNode({ data, selected }: NodeProps) {
  const T = useT();
  const conditions = (data.conditions as any[]) || [];
  const summary = conditions.length > 0
    ? T({ en: `${conditions.length} condition${conditions.length > 1 ? "s" : ""}`, zh: `${conditions.length} 个条件` })
    : T({ en: "Configure...", zh: "待配置…" });

  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[170px] ${selected ? "border-blue-500 shadow-md" : "border-indigo-300"}`}>
      <Handle type="target" position={Position.Left} className="!bg-indigo-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        {/* i18n-ok: SVG path data, not user-facing text */}
        <svg className="w-4 h-4 text-indigo-600" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" /></svg>
        <span className="font-semibold text-sm text-indigo-700">{T(nodeLabel("userPropsCondition"))}</span>
      </div>
      <p className={`text-xs ${conditions.length > 0 ? "text-gray-700" : "text-gray-400 italic"}`}>{summary}</p>
      <AnalyticsBadges analytics={data._analytics as any} />
      <span className="absolute right-1 text-[10px] text-green-600" style={{ top: "35%", transform: "translateY(-50%)" }}>{T(C.yes)}</span>
      <span className="absolute right-1 text-[10px] text-red-500" style={{ top: "65%", transform: "translateY(-50%)" }}>{T(C.no)}</span>
      <Handle type="source" position={Position.Right} id="yes" className="!bg-green-500 !w-2.5 !h-2.5" style={{ top: "35%" }} />
      <Handle type="source" position={Position.Right} id="no" className="!bg-red-400 !w-2.5 !h-2.5" style={{ top: "65%" }} />
    </div>
  );
}
