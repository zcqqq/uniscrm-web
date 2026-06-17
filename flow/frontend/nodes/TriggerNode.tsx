import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CHANNEL_TYPES } from "../config/trigger-fields";

export default function TriggerNode({ data, selected }: NodeProps) {
  const channelType = data.channelType as string | undefined;
  const eventType = data.eventType as string | undefined;

  const ctDef = CHANNEL_TYPES.find((ct) => ct.channelType === channelType);
  const evDef = ctDef?.events.find((e) => e.eventType === eventType);

  const title = ctDef?.label || "Trigger";
  const subtitle = evDef?.label || "Select event...";

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${
        selected ? "border-blue-500 shadow-md" : "border-purple-300"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-lg">{ctDef?.icon || "⚡"}</span>
        <div>
          <span className="font-semibold text-sm text-purple-700">{title}</span>
          {eventType && (
            <p className="text-xs text-gray-500">{subtitle}</p>
          )}
          {!eventType && (
            <p className="text-xs text-gray-400 italic">Not configured</p>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-purple-500 !w-3 !h-3" />
    </div>
  );
}
