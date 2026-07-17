import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";

export default function CronTriggerNode({ data, selected }: NodeProps) {
  const scheduleType = data.scheduleType as string;
  let summary = "Configure...";
  if (scheduleType === "daily") summary = `Daily at ${data.dailyTime || "09:00"}`;
  else if (scheduleType === "interval") summary = `Every ${data.intervalValue || 60} ${data.intervalUnit || "minutes"}`;
  else if (scheduleType === "cron") summary = data.cronExpr as string || "0 * * * *";

  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${selected ? "border-blue-500 shadow-md" : "border-purple-300"}`}>
      <div className="flex items-center gap-2 mb-1">
        <svg className="w-4 h-4 text-purple-600" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
        <span className="font-semibold text-sm text-purple-700">{NODE_TYPE_REGISTRY.cronTrigger.label}</span>
      </div>
      <p className={`text-xs ${scheduleType ? "text-gray-700" : "text-gray-400 italic"}`}>{summary}</p>
      <AnalyticsBadges analytics={data._analytics as any} />
      <Handle type="source" position={Position.Right} className="!bg-purple-500 !w-3 !h-3" />
    </div>
  );
}
