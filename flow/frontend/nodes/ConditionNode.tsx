import { Handle, Position, type NodeProps } from "@xyflow/react";

export default function ConditionNode({ data, selected }: NodeProps) {
  const field = data.field as string;
  const operator = data.operator as string;
  const value = data.value as string;

  const hasCondition = field && value;
  const summary = hasCondition ? `${field} ${operator} ${value}` : "Configure condition...";

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[180px] ${
        selected ? "border-blue-500 shadow-md" : "border-amber-300"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-amber-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">🔀</span>
        <span className="font-semibold text-sm text-amber-700">Condition</span>
      </div>
      <p className={`text-xs ${hasCondition ? "text-gray-700 font-mono" : "text-gray-400 italic"}`}>
        {summary}
      </p>
      <Handle type="source" position={Position.Bottom} className="!bg-amber-500 !w-3 !h-3" />
    </div>
  );
}
