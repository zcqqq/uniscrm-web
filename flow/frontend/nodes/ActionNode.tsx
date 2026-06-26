import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";

const EXTERNAL_API_ACTIONS = ["xAction"];

export default function ActionNode({ data, selected }: NodeProps) {
  const actionType = data.actionType as string;
  const isExternalApi = EXTERNAL_API_ACTIONS.includes(actionType);

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
    description = xEvent === "follow-user" ? "Follow User"
      : xEvent === "unfollow-user" ? "Unfollow User"
      : xEvent === "create-dm" ? "Direct Message"
      : xEvent === "mute-user" ? "Mute User"
      : "4 actions";
    icon = "𝕏";
  } else {
    label = "Action";
    description = "Unknown action";
    icon = "⚡";
  }

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${
        selected ? "border-blue-500 shadow-md" : "border-green-300"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-green-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">{icon}</span>
        <span className="font-semibold text-sm text-green-700">{label}</span>
      </div>
      <p className={`text-xs ${data.listName || data.xEvent ? "text-gray-500" : "text-gray-400 italic"}`}>
        {description}
      </p>
      <AnalyticsBadges analytics={data._analytics as any} />
      {isExternalApi && (
        <div className="absolute right-0 top-0 h-full flex flex-col justify-around pr-1 text-[10px]">
          <span className="text-green-600">Success</span>
          <span className="text-red-500">Failed</span>
        </div>
      )}
      {isExternalApi ? (
        <>
          <Handle type="source" position={Position.Right} id="success"
            className="!bg-green-500 !w-2.5 !h-2.5" style={{ top: "35%" }} />
          <Handle type="source" position={Position.Right} id="failed"
            className="!bg-red-400 !w-2.5 !h-2.5" style={{ top: "65%" }} />
        </>
      ) : (
        <Handle type="source" position={Position.Right} className="!bg-green-500 !w-3 !h-3" />
      )}
    </div>
  );
}
