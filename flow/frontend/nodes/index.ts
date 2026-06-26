import XTriggerNode from "./XTriggerNode";
import ActionNode from "./ActionNode";
import WaitNode from "./WaitNode";
import WaitForEventNode from "./WaitForEventNode";

export const nodeTypes = {
  xTrigger: XTriggerNode,
  action: ActionNode,
  wait: WaitNode,
  waitForEvent: WaitForEventNode,
};
