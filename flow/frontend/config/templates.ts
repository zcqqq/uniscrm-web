import { CONTENT_X_TRIGGER_MODE_LIST_POSTS } from "../../nodeTypeRegistry";
import type { LocalizedString } from "../../../metadata/dataTypes";

export interface FlowTemplate {
  id: string;
  name: LocalizedString;
  description: LocalizedString;
  domain: "user" | "content";
  graph: {
    nodes: { id: string; type: string; position: { x: number; y: number }; data: Record<string, unknown> }[];
    edges: { id: string; source: string; target: string; sourceHandle?: string }[];
  };
}

export const FLOW_TEMPLATES: FlowTemplate[] = [
  {
    id: "tpl-follow-back-blue",
    name: { en: "Follow back Blue Premium", zh: "回关 Blue 认证用户" },
    description: {
      en: "When a Blue-verified user follows you, automatically follow them back",
      zh: "当已通过 Blue 认证的用户关注你时，自动回关",
    },
    domain: "user",
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
    name: { en: "Unfollow who unfollows me", zh: "取关取关我的人" },
    description: {
      en: "When someone unfollows you, automatically unfollow them back",
      zh: "有人取关你时，自动取关对方",
    },
    domain: "user",
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
    name: { en: "DM if not followed back", zh: "关注未回关则私信" },
    description: {
      en: "After following someone, if they don't follow back in 1 day, send a Direct Message; if still no response, unfollow and mute",
      zh: "关注对方后，若 1 天内未回关则发送私信；仍无回应则取关并将其静音",
    },
    domain: "user",
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
  {
    id: "tpl-content-rewrite-crosspost",
    name: { en: "AI-rewrite new List posts", zh: "AI 改写名单新帖" },
    description: {
      en: "When a new post is ingested from an X List, rewrite it with AI and publish it via the same channel",
      zh: "当 X 名单中出现新帖子时，用 AI 改写后通过同一账号发布",
    },
    domain: "content",
    graph: {
      nodes: [
        { id: "t1", type: "xContentTrigger", position: { x: 0, y: 0 }, data: { channelId: "", mode: CONTENT_X_TRIGGER_MODE_LIST_POSTS, listId: "", listName: "", conditions: [] } },
        { id: "a1", type: "action", position: { x: 320, y: 0 }, data: { actionType: "xContentAction", operation: "create-post", prompt: "$content.content_text", provider: "default" } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
      ],
    },
  },
];
