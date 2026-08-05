import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { nodeLabel } from "../config/nodeTypeLabels";
import { unitLabel } from "../lib/unit-label";
import { useT } from "../../../shared/frontend/hooks/useT";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";

export default function CronTriggerNode({ data, selected }: NodeProps) {
  const T = useT();
  const { locale } = useLocale();
  const scheduleType = data.scheduleType as string;
  let summary = T({ en: "Configure...", zh: "待配置…" });
  if (scheduleType === "daily") {
    summary = locale === "zh" ? `每天 ${data.dailyTime || "09:00"}` : `Daily at ${data.dailyTime || "09:00"}`;
  } else if (scheduleType === "interval") {
    const unit = unitLabel((data.intervalUnit as string) || "minutes", locale);
    summary = locale === "zh" ? `每 ${data.intervalValue || 60} ${unit}` : `Every ${data.intervalValue || 60} ${unit}`;
  } else if (scheduleType === "cron") {
    summary = (data.cronExpr as string) || "0 * * * *";
  }

  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${selected ? "border-blue-500 shadow-md" : "border-purple-300"}`}>
      <div className="flex items-center gap-2 mb-1">
        {/* i18n-ok: SVG path data, not user-facing text */}
        <svg className="w-4 h-4 text-purple-600" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
        <span className="font-semibold text-sm text-purple-700">{T(nodeLabel("cronTrigger"))}</span>
      </div>
      <p className={`text-xs ${scheduleType ? "text-gray-700" : "text-gray-400 italic"}`}>{summary}</p>
      <AnalyticsBadges analytics={data._analytics as any} />
      <Handle type="source" position={Position.Right} className="!bg-purple-500 !w-3 !h-3" />
    </div>
  );
}
