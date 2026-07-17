import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CHANNEL_TYPES } from "../config/trigger-fields";
import AnalyticsBadges from "./AnalyticsBadges";
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";

export default function EventHistoryNode({ data, selected }: NodeProps) {
  const eventType = data.eventType as string;

  let eventLabel = eventType;
  for (const ct of CHANNEL_TYPES) {
    const ev = ct.events.find((e) => e.eventType === eventType);
    if (ev) { eventLabel = ev.label; break; }
  }

  const duration = data.duration as number;
  const unit = data.unit as string;
  const conditions = (data.conditions as any[]) || [];
  const timeStr = duration ? ` within ${duration} ${unit}` : "";
  const condStr = conditions.length > 0 ? ` (${conditions.length} filter${conditions.length > 1 ? "s" : ""})` : "";
  const summary = eventType ? `${eventLabel}${timeStr}${condStr}` : "Configure...";

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[180px] ${
        selected ? "border-blue-500 shadow-md" : "border-indigo-300"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-indigo-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">🔍</span>
        <span className="font-semibold text-sm text-indigo-700">{NODE_TYPE_REGISTRY.waitForEvent.label}</span>
      </div>
      <p className={`text-xs ${eventType ? "text-gray-700" : "text-gray-400 italic"}`}>
        {summary}
      </p>
      <AnalyticsBadges analytics={data._analytics as any} />
      <span className="absolute right-1 text-[10px] text-green-600" style={{ top: "35%", transform: "translateY(-50%)" }}>Yes</span>
      <span className="absolute right-1 text-[10px] text-red-500" style={{ top: "65%", transform: "translateY(-50%)" }}>No</span>
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
