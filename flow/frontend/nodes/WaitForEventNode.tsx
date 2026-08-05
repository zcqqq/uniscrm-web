import { Handle, Position, type NodeProps } from "@xyflow/react";
import { getChannelTypes } from "../config/trigger-fields";
import AnalyticsBadges from "./AnalyticsBadges";
import { nodeLabel } from "../config/nodeTypeLabels";
import { conditionSummary } from "../lib/condition-logic";
import { unitLabel } from "../lib/unit-label";
import { useT } from "../../../shared/frontend/hooks/useT";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";
import { C } from "../../../shared/frontend/i18n-common";

export default function EventHistoryNode({ data, selected }: NodeProps) {
  const T = useT();
  const { locale } = useLocale();
  const eventType = data.eventType as string;

  let eventLabel = eventType;
  for (const ct of getChannelTypes(locale)) {
    const ev = ct.events.find((e) => e.eventType === eventType);
    if (ev) { eventLabel = ev.label; break; }
  }

  const duration = data.duration as number;
  const unit = data.unit as string;
  const conditions = (data.conditions as unknown[]) || [];
  // 与另外四个卡片同一口径：空 field 的半成品行不计数（"+ Add" 会先插一个空行）。
  const condCount = conditions.filter((c: any) => c?.field).length;
  const timeStr = duration
    ? (locale === "zh" ? `，${duration} ${unitLabel(unit, locale)}内` : ` within ${duration} ${unitLabel(unit, locale)}`)
    : "";
  const condStr = condCount > 0
    ? (locale === "zh" ? `（${conditionSummary(condCount, data.conditionLogic, locale)}）` : ` (${conditionSummary(condCount, data.conditionLogic, locale)})`)
    : "";
  const summary = eventType ? `${eventLabel}${timeStr}${condStr}` : T({ en: "Configure...", zh: "待配置…" });

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[180px] ${
        selected ? "border-blue-500 shadow-md" : "border-indigo-300"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-indigo-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">🔍</span>
        <span className="font-semibold text-sm text-indigo-700">{T(nodeLabel("waitForEvent"))}</span>
      </div>
      <p className={`text-xs ${eventType ? "text-gray-700" : "text-gray-400 italic"}`}>
        {summary}
      </p>
      <AnalyticsBadges analytics={data._analytics as any} />
      <span className="absolute right-1 text-[10px] text-green-600" style={{ top: "35%", transform: "translateY(-50%)" }}>{T(C.yes)}</span>
      <span className="absolute right-1 text-[10px] text-red-500" style={{ top: "65%", transform: "translateY(-50%)" }}>{T(C.no)}</span>
      <Handle
        type="source"
        position={Position.Right}
        id="yes"
        className="!bg-green-500 !w-2.5 !h-2.5"
        style={{ top: "35%" }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="no"
        className="!bg-red-400 !w-2.5 !h-2.5"
        style={{ top: "65%" }}
      />
    </div>
  );
}
