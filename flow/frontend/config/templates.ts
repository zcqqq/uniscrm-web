export interface FlowTemplate {
  id: string;
  name: string;
  description: string;
  graph: {
    nodes: { id: string; type: string; position: { x: number; y: number }; data: Record<string, unknown> }[];
    edges: { id: string; source: string; target: string; sourceHandle?: string }[];
  };
}

export const FLOW_TEMPLATES: FlowTemplate[] = [
  {
    id: "tpl-auto-follow-back",
    name: "Auto Follow Back",
    description: "When someone follows you, wait 1 day, then follow them back",
    graph: {
      nodes: [
        { id: "t1", type: "trigger", position: { x: 300, y: 50 }, data: { channelType: "X", eventType: "follow.followed", channelId: "" } },
        { id: "w1", type: "wait", position: { x: 300, y: 180 }, data: { duration: 1, unit: "days" } },
        { id: "a1", type: "action", position: { x: 300, y: 310 }, data: { actionType: "xAction", xEvent: "follow-user", channelId: "" } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "w1" },
        { id: "e2", source: "w1", target: "a1" },
      ],
    },
  },
  {
    id: "tpl-no-follow-back-list",
    name: "No Follow Back → Add to List",
    description: "After following someone, if they don't follow back within 1 day, add them to a list",
    graph: {
      nodes: [
        { id: "t1", type: "trigger", position: { x: 300, y: 50 }, data: { channelType: "X", eventType: "follow.follow", channelId: "" } },
        { id: "w1", type: "wait", position: { x: 300, y: 180 }, data: { duration: 1, unit: "days" } },
        { id: "eh1", type: "eventHistory", position: { x: 300, y: 310 }, data: { eventType: "follow.followed", channelId: "" } },
        { id: "a1", type: "action", position: { x: 400, y: 450 }, data: { actionType: "addToList", listId: "", listName: "" } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "w1" },
        { id: "e2", source: "w1", target: "eh1" },
        { id: "e3", source: "eh1", sourceHandle: "no", target: "a1" },
      ],
    },
  },
];
