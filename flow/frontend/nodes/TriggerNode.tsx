import { Handle, Position, type NodeProps } from "@xyflow/react";
import { getTriggerType } from "../config/trigger-fields";

export default function TriggerNode({ data, selected }: NodeProps) {
  const triggerType = data.triggerType as string;
  const def = getTriggerType(triggerType);

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[180px] ${
        selected ? "border-blue-500 shadow-md" : "border-purple-300"
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">⚡</span>
        <span className="font-semibold text-sm text-purple-700">{def?.label || triggerType}</span>
      </div>
      <p className="text-xs text-gray-500">{def?.description || "Trigger"}</p>
      {def && (
        <div className="mt-2 flex flex-wrap gap-1">
          {def.contextFields.slice(0, 3).map((f) => (
            <span key={f.id} className="text-[10px] px-1.5 py-0.5 bg-purple-50 text-purple-600 rounded">
              {f.label}
            </span>
          ))}
          {def.contextFields.length > 3 && (
            <span className="text-[10px] text-gray-400">+{def.contextFields.length - 3}</span>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-purple-500 !w-3 !h-3" />
    </div>
  );
}
