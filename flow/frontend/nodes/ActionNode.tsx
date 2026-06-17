import { Handle, Position, type NodeProps } from "@xyflow/react";

export default function ActionNode({ data, selected }: NodeProps) {
  const actionType = data.actionType as string;

  let label: string;
  let description: string;
  let icon: string;

  if (actionType === "addToList") {
    const listName = data.listName as string;
    label = "Add to List";
    description = listName || "Select a list...";
    icon = "📋";
  } else if (actionType === "xAction") {
    const xEvent = data.xEvent as string;
    label = "X Action";
    description = xEvent === "follow-user" ? "Follow User" : xEvent === "unfollow-user" ? "Unfollow User" : "Select action...";
    icon = "𝕏";
  } else {
    label = "Add Point (+1)";
    description = "Increment user point by 1";
    icon = "🎯";
  }

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${
        selected ? "border-blue-500 shadow-md" : "border-green-300"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-green-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">{icon}</span>
        <span className="font-semibold text-sm text-green-700">{label}</span>
      </div>
      <p className={`text-xs ${data.listName || actionType === "addPoint" ? "text-gray-500" : "text-gray-400 italic"}`}>
        {description}
      </p>
    </div>
  );
}
