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
import ChangeUserPropsNode from "./ChangeUserPropsNode";
import VideoConditionNode from "./VideoConditionNode";

export const nodeTypes = {
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
  changeUserProps: ChangeUserPropsNode,
};
