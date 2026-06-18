import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CHANNEL_TYPES } from "../config/trigger-fields";

export default function EventHistoryNode({ data, selected }: NodeProps) {
  const eventType = data.eventType as string;

  let eventLabel = eventType;
  for (const ct of CHANNEL_TYPES) {
    const ev = ct.events.find((e) => e.eventType === eventType);
    if (ev) { eventLabel = ev.label; break; }
  }

  const duration = data.duration as number;
  const unit = data.unit as string;
  const timeStr = duration ? ` within ${duration} ${unit}` : "";
  const summary = eventType ? `${eventLabel}${timeStr}` : "Configure...";

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[180px] ${
        selected ? "border-blue-500 shadow-md" : "border-indigo-300"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-indigo-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">🔍</span>
        <span className="font-semibold text-sm text-indigo-700">Wait for Event</span>
      </div>
      <p className={`text-xs ${eventType ? "text-gray-700" : "text-gray-400 italic"}`}>
        {summary}
      </p>
      <div className="flex justify-between mt-2 text-[10px] text-gray-500 px-1">
        <span className="text-green-600">Yes</span>
        <span className="text-red-500">No</span>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        id="yes"
        className="!bg-green-500 !w-2.5 !h-2.5"
        style={{ left: "30%" }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="no"
        className="!bg-red-400 !w-2.5 !h-2.5"
        style={{ left: "70%" }}
      />
    </div>
  );
}
