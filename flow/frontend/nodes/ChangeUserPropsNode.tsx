import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";

export default function ChangeUserPropsNode({ data, selected }: NodeProps) {
  const updates = (data.updates as any[]) || [];
  const summary = updates.length > 0 ? `${updates.length} field${updates.length > 1 ? "s" : ""}` : "Configure...";

  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${selected ? "border-blue-500 shadow-md" : "border-green-300"}`}>
      <Handle type="target" position={Position.Left} className="!bg-green-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM4 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 0110.374 21c-2.331 0-4.512-.645-6.374-1.766z" /></svg>
        <span className="font-semibold text-sm text-green-700">Change Props</span>
      </div>
      <p className={`text-xs ${updates.length > 0 ? "text-gray-700" : "text-gray-400 italic"}`}>{summary}</p>
      <AnalyticsBadges analytics={data._analytics as any} />
      <Handle type="source" position={Position.Right} className="!bg-green-500 !w-3 !h-3" />
    </div>
  );
}
