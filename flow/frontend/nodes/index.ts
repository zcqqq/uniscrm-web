import TriggerNode from "./TriggerNode";
import ConditionNode from "./ConditionNode";
import ActionNode from "./ActionNode";
import WaitNode from "./WaitNode";
import EventHistoryNode from "./EventHistoryNode";

export const nodeTypes = {
  trigger: TriggerNode,
  condition: ConditionNode,
  action: ActionNode,
  wait: WaitNode,
  eventHistory: EventHistoryNode,
};
