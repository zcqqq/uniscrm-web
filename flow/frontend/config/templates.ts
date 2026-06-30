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
    id: "tpl-follow-back-blue",
    name: "Follow back Blue Premium",
    description: "When a Blue-verified user follows you, automatically follow them back",
    graph: {
      nodes: [
        { id: "t1", type: "xTrigger", position: { x: 0, y: 0 }, data: { channelType: "X", eventType: "follow.followed", channelId: "", conditions: [{ field: "verified_type", operator: "==", value: "blue" }] } },
        { id: "a1", type: "action", position: { x: 320, y: 0 }, data: { actionType: "xAction", xEvent: "follow-user", channelId: "" } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
      ],
    },
  },
  {
    id: "tpl-unfollow-unfollowers",
    name: "Unfollow who unfollows me",
    description: "When someone unfollows you, automatically unfollow them back",
    graph: {
      nodes: [
        { id: "t1", type: "xTrigger", position: { x: 0, y: 0 }, data: { channelType: "X", eventType: "follow.unfollowed", channelId: "", conditions: [] } },
        { id: "a1", type: "action", position: { x: 320, y: 0 }, data: { actionType: "xAction", xEvent: "unfollow-user", channelId: "" } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
      ],
    },
  },
  {
    id: "tpl-dm-not-followed-back",
    name: "DM if not followed back",
    description: "After following someone, if they don't follow back in 1 day, send a DM; if still no response, unfollow and mute",
    graph: {
      nodes: [
        { id: "t1", type: "xTrigger", position: { x: 0, y: 80 }, data: { channelType: "X", eventType: "follow.follow", channelId: "", conditions: [] } },
        { id: "w1", type: "waitForEvent", position: { x: 320, y: 80 }, data: { eventType: "follow.followed", channelId: "", duration: 1, unit: "days", conditions: [] } },
        { id: "a1", type: "action", position: { x: 640, y: 80 }, data: { actionType: "xAction", xEvent: "create-dm", channelId: "", messageText: "Hi, 可以互关吗？谢谢！" } },
        { id: "w2", type: "waitForEvent", position: { x: 960, y: 0 }, data: { eventType: "follow.followed", channelId: "", duration: 1, unit: "days", conditions: [] } },
        { id: "a2", type: "action", position: { x: 960, y: 160 }, data: { actionType: "xAction", xEvent: "unfollow-user", channelId: "" } },
        { id: "a3", type: "action", position: { x: 1280, y: 160 }, data: { actionType: "xAction", xEvent: "mute-user", channelId: "" } },
        { id: "a4", type: "action", position: { x: 1280, y: 0 }, data: { actionType: "xAction", xEvent: "unfollow-user", channelId: "" } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "w1" },
        { id: "e2", source: "w1", sourceHandle: "no", target: "a1" },
        { id: "e3", source: "a1", sourceHandle: "success", target: "w2" },
        { id: "e4", source: "a1", sourceHandle: "failed", target: "a2" },
        { id: "e5", source: "a2", sourceHandle: "success", target: "a3" },
        { id: "e6", source: "a2", sourceHandle: "failed", target: "a3" },
        { id: "e7", source: "w2", sourceHandle: "no", target: "a4" },
      ],
    },
  },
];
