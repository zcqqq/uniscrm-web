import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { nodeLabel } from "../config/nodeTypeLabels";
import { CHANNEL_TYPES } from "../config/trigger-fields";
import { ContentMetadata_X } from "../../../metadata/x-byok";
import { ContentMetadata_YouTube } from "../../../metadata/youtube";
import { t as localizeLabel } from "../../../metadata/locale";
import { XIcon, TikTokIcon, YouTubeIcon } from "../../../shared/frontend/ui/icons";
import { Tooltip, TooltipTrigger, TooltipContent } from "../../../shared/frontend/ui/tooltip";
import { useT } from "../../../shared/frontend/hooks/useT";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";

const EXTERNAL_API_ACTIONS = ["xAction", "xContentAction", "tiktokContentAction", "videoAction", "youtubeContentAction"];
// Count only — locale-invariant, so the module-level frozen CHANNEL_TYPES is fine here (no
// text ever reaches the user through this constant).
const X_ACTION_COUNT = CHANNEL_TYPES.find((ct) => ct.channelType === "X")!.actions.length;
const CONTENT_X_ACTION_OPERATIONS = ContentMetadata_X.filter((m) => m.flowType === "action");
const CONTENT_YOUTUBE_ACTION_OPERATIONS_NODE = ContentMetadata_YouTube.filter((m) => m.flowType === "action");

export default function ActionNode({ data, selected }: NodeProps) {
  const T = useT();
  const { locale } = useLocale();
  const actionType = data.actionType as string;
  const isExternalApi = EXTERNAL_API_ACTIONS.includes(actionType);

  let label: string;
  let description: string | undefined;
  let icon: React.ComponentType<{ className?: string }> | string;
  let isConfigured: boolean;

  if (actionType === "addToList") {
    const listName = data.listName as string;
    label = T(nodeLabel("addToList"));
    description = listName || T({ en: "Select a list...", zh: "选择名单…" });
    icon = "📋";
    isConfigured = !!listName;
  } else if (actionType === "xAction") {
    const xEvent = data.xEvent as string;
    label = T(nodeLabel("xAction"));
    description = xEvent === "follow-user" ? T({ en: "Follow User", zh: "关注用户" })
      : xEvent === "unfollow-user" ? T({ en: "Unfollow User", zh: "取消关注" })
      : xEvent === "create-dm" ? T({ en: "Direct Message", zh: "私信" })
      : xEvent === "mute-user" ? T({ en: "Mute User", zh: "静音用户" })
      : T({ en: `${X_ACTION_COUNT} actions`, zh: `${X_ACTION_COUNT} 个动作` });
    icon = XIcon;
    isConfigured = !!xEvent;
  } else if (actionType === "xContentAction") {
    const operation = (data.operation as string) || "create-post";
    const selectedOperation = CONTENT_X_ACTION_OPERATIONS.find((op) => op.sourceContentType === operation);
    label = T(nodeLabel("xContentAction"));
    description = selectedOperation?.label ? localizeLabel(selectedOperation.label, locale) : undefined;
    icon = XIcon;
    isConfigured = !!selectedOperation;
  } else if (actionType === "tiktokContentAction") {
    const channelId = data.channelId as string;
    label = T(nodeLabel("tiktokContentAction"));
    description = channelId ? T({ en: "Target channel selected", zh: "已选择目标渠道" }) : T({ en: "Select a target channel...", zh: "选择目标渠道…" });
    icon = TikTokIcon;
    isConfigured = !!channelId;
  } else if (actionType === "youtubeContentAction") {
    const operation = (data.operation as string) || "save-to-playlist";
    const selectedOperation = CONTENT_YOUTUBE_ACTION_OPERATIONS_NODE.find((op) => op.sourceContentType === operation);
    label = T(nodeLabel("youtubeContentAction"));
    description = selectedOperation?.label ? localizeLabel(selectedOperation.label, locale) : undefined;
    icon = YouTubeIcon;
    isConfigured = operation === "rate-like" || (operation === "save-to-playlist" && !!data.playlistId);
  } else if (actionType === "videoAction") {
    const operation = (data.operation as string) || "add-subtitle";
    label = T(nodeLabel("videoAction"));
    description = operation === "rotate-to-vertical" ? T({ en: "Rotate to Vertical", zh: "旋转为竖屏" })
      : operation === "remove-face" ? T({ en: "Remove Face", zh: "移除人脸" })
      : T({ en: "Add Subtitle", zh: "添加字幕" });
    icon = "🎬";
    isConfigured = true;
  } else {
    label = T({ en: "Action", zh: "动作" });
    description = T({ en: "Unknown action", zh: "未知动作" });
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
          <span className="absolute right-1 text-[10px] text-green-600" style={{ top: "35%", transform: "translateY(-50%)" }}>{T({ en: "Success", zh: "成功" })}</span>
          <span className="absolute right-1 text-[10px] text-red-500" style={{ top: "65%", transform: "translateY(-50%)" }}>{T({ en: "Failed", zh: "失败" })}</span>
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
