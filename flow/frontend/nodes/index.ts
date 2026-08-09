import type { ComponentType } from "react";
import type { ReactFlowNodeType } from "../../nodeTypeRegistry";
import XTriggerNode from "./XTriggerNode";
import XContentTriggerNode from "./XContentTriggerNode";
import YouTubeContentTriggerNode from "./YouTubeContentTriggerNode";
import CronTriggerNode from "./CronTriggerNode";
import ActionNode from "./ActionNode";
import WaitNode from "./WaitNode";
import WaitForEventNode from "./WaitForEventNode";
import TimeConditionNode from "./TimeConditionNode";
import UserPropsConditionNode from "./UserPropsConditionNode";
import AbSplitNode from "./AbSplitNode";
import WebhookNode from "./WebhookNode";
import VideoConditionNode from "./VideoConditionNode";
import YouTubeConditionNode from "./YouTubeConditionNode";

// Exhaustively keyed by the registry's ReactFlowNodeType union: a new registry entry with a new
// reactFlowType fails to compile until its canvas component is added here. (The legacy
// pre-registry "condition" type has no component — old graphs render it as React Flow's default
// node, unchanged.)
export const nodeTypes: Record<ReactFlowNodeType, ComponentType<any>> = {
  xTrigger: XTriggerNode,
  xContentTrigger: XContentTriggerNode,
  youtubeContentTrigger: YouTubeContentTriggerNode,
  cronTrigger: CronTriggerNode,
  action: ActionNode,
  wait: WaitNode,
  waitForEvent: WaitForEventNode,
  timeCondition: TimeConditionNode,
  userPropsCondition: UserPropsConditionNode,
  abSplit: AbSplitNode,
  webhook: WebhookNode,
  videoCondition: VideoConditionNode,
  youtubeCondition: YouTubeConditionNode,
};
