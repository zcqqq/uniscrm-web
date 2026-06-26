import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CHANNEL_TYPES } from "../config/trigger-fields";
import AnalyticsBadges from "./AnalyticsBadges";

export default function TriggerNode({ data, selected }: NodeProps) {
  const channelType = data.channelType as string | undefined;
  const eventType = data.eventType as string | undefined;
  const conditions = (data.conditions as unknown[]) || [];
  const condCount = conditions.filter((c: any) => c?.field).length;

  const ctDef = CHANNEL_TYPES.find((ct) => ct.channelType === channelType);
  const evDef = ctDef?.events.find((e) => e.eventType === eventType);

  const title = ctDef ? `${ctDef.label} Trigger` : "Trigger";
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
          {condCount > 0 && (
            <p className="text-xs text-purple-500">{condCount} condition{condCount > 1 ? "s" : ""}</p>
          )}
        </div>
      </div>
      <AnalyticsBadges analytics={data._analytics as any} />
      <Handle type="source" position={Position.Right} className="!bg-purple-500 !w-3 !h-3" />
    </div>
  );
}
