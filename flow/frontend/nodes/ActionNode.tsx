import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";
import { CHANNEL_TYPES } from "../config/trigger-fields";
import { ContentMetadata_X } from "../../../metadata/x-byok";
import { t as localizeLabel } from "../../../metadata/locale";
import { XIcon, TikTokIcon } from "../../../shared/frontend/ui/icons";
import { Tooltip, TooltipTrigger, TooltipContent } from "../../../shared/frontend/ui/tooltip";

const EXTERNAL_API_ACTIONS = ["xAction", "xContentAction", "tiktokContentAction", "videoAction"];
const X_ACTION_COUNT = CHANNEL_TYPES.find((ct) => ct.channelType === "X")!.actions.length;
const CONTENT_X_ACTION_OPERATIONS = ContentMetadata_X.filter((m) => m.flowType === "action");

export default function ActionNode({ data, selected }: NodeProps) {
  const actionType = data.actionType as string;
  const isExternalApi = EXTERNAL_API_ACTIONS.includes(actionType);

  let label: string;
  let description: string | undefined;
  let icon: React.ComponentType<{ className?: string }> | string;
  let isConfigured: boolean;

  if (actionType === "addToList") {
    const listName = data.listName as string;
    label = NODE_TYPE_REGISTRY.addToList.label!;
    description = listName || "Select a list...";
    icon = "📋";
    isConfigured = !!listName;
  } else if (actionType === "xAction") {
    const xEvent = data.xEvent as string;
    label = NODE_TYPE_REGISTRY.xAction.label!;
    description = xEvent === "follow-user" ? "Follow User"
      : xEvent === "unfollow-user" ? "Unfollow User"
      : xEvent === "create-dm" ? "Direct Message"
      : xEvent === "mute-user" ? "Mute User"
      : `${X_ACTION_COUNT} actions`;
    icon = XIcon;
    isConfigured = !!xEvent;
  } else if (actionType === "xContentAction") {
    const operation = (data.operation as string) || "create-post";
    const selectedOperation = CONTENT_X_ACTION_OPERATIONS.find((op) => op.sourceContentType === operation);
    label = NODE_TYPE_REGISTRY.xContentAction.label!;
    description = selectedOperation?.label ? localizeLabel(selectedOperation.label, "en") : undefined;
    icon = XIcon;
    isConfigured = !!selectedOperation;
  } else if (actionType === "tiktokContentAction") {
    const channelId = data.channelId as string;
    label = NODE_TYPE_REGISTRY.tiktokContentAction.label!;
    description = channelId ? "Target channel selected" : "Select a target channel...";
    icon = TikTokIcon;
    isConfigured = !!channelId;
  } else if (actionType === "videoAction") {
    const operation = (data.operation as string) || "add-subtitle";
    label = NODE_TYPE_REGISTRY.videoAction.label!;
    description = operation === "rotate-to-vertical" ? "Rotate to Vertical"
      : operation === "remove-face" ? "Remove Face"
      : "Add Subtitle";
    icon = "🎬";
    isConfigured = true;
  } else {
    label = "Action";
    description = "Unknown action";
    icon = "⚡";
    isConfigured = false;
  }

  const IconComponent = typeof icon === "string" ? null : icon;

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${
        selected ? "border-blue-500 shadow-md" : "border-green-300"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-green-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              {IconComponent ? <IconComponent className="w-4 h-4" /> : <span className="text-lg">{icon as string}</span>}
            </span>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
        <span className="font-semibold text-sm text-green-700">{label}</span>
      </div>
      {description && (
        <p className={`text-xs ${isConfigured ? "text-gray-500" : "text-gray-400 italic"}`}>
          {description}
        </p>
      )}
      <AnalyticsBadges analytics={data._analytics as any} />
      {isExternalApi && (
        <>
          <span className="absolute right-1 text-[10px] text-green-600" style={{ top: "35%", transform: "translateY(-50%)" }}>Success</span>
          <span className="absolute right-1 text-[10px] text-red-500" style={{ top: "65%", transform: "translateY(-50%)" }}>Failed</span>
        </>
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
