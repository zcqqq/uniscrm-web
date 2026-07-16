import XTriggerNode from "./XTriggerNode";
import XContentTriggerNode from "./XContentTriggerNode";
import CronTriggerNode from "./CronTriggerNode";
import ActionNode from "./ActionNode";
import WaitNode from "./WaitNode";
import WaitForEventNode from "./WaitForEventNode";
import TimeConditionNode from "./TimeConditionNode";
import UserPropsConditionNode from "./UserPropsConditionNode";
import AbSplitNode from "./AbSplitNode";
import WebhookNode from "./WebhookNode";
import ChangeUserPropsNode from "./ChangeUserPropsNode";

export const nodeTypes = {
  xTrigger: XTriggerNode,
  xContentTrigger: XContentTriggerNode,
  cronTrigger: CronTriggerNode,
  action: ActionNode,
  wait: WaitNode,
  waitForEvent: WaitForEventNode,
  timeCondition: TimeConditionNode,
  userPropsCondition: UserPropsConditionNode,
  abSplit: AbSplitNode,
  webhook: WebhookNode,
  changeUserProps: ChangeUserPropsNode,
};
