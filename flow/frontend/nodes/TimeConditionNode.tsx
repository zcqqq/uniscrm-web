import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";

export default function TimeConditionNode({ data, selected }: NodeProps) {
  const timeFrom = data.timeFrom as string;
  const timeTo = data.timeTo as string;
  const days = data.daysOfWeek as number[] || [];
  const summary = timeFrom && timeTo ? `${timeFrom}–${timeTo}` : "Configure...";
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${selected ? "border-blue-500 shadow-md" : "border-indigo-300"}`}>
      <Handle type="target" position={Position.Left} className="!bg-indigo-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <svg className="w-4 h-4 text-indigo-600" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
        <span className="font-semibold text-sm text-indigo-700">Time Condition</span>
      </div>
      <p className={`text-xs ${timeFrom ? "text-gray-700" : "text-gray-400 italic"}`}>{summary}</p>
      {days.length > 0 && <p className="text-[10px] text-gray-500">{days.map(d => dayNames[d]).join(", ")}</p>}
      <AnalyticsBadges analytics={data._analytics as any} />
      <Handle type="source" position={Position.Right} className="!bg-indigo-500 !w-3 !h-3" />
    </div>
  );
}
