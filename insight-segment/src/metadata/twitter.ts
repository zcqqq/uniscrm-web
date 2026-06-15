import type { FieldDefinition } from "./types";

export const TWITTER_FIELDS: FieldDefinition[] = [
  {
    propId: "followers_count",
    dataType: "INT",
    source: "user_x",
    sqlExpr: "CAST(json_extract(user_x.raw_data, '$.public_metrics.followers_count') AS INTEGER)",
    description: "粉丝数",
  },
  {
    propId: "verified_type",
    dataType: "ENUM",
    source: "user_x",
    sqlExpr: "json_extract(user_x.raw_data, '$.verified_type')",
    description: "认证类型",
    enums: [
      { value: "blue", label: "蓝V" },
      { value: "none", label: "无" },
    ],
  },
  {
    propId: "event_type",
    dataType: "ENUM",
    source: "event_x",
    sqlExpr: "event_x.event_type",
    description: "事件类型",
    enums: [
      { value: "follow_event", label: "关注" },
      { value: "follower", label: "粉丝同步" },
      { value: "chat_received", label: "私信" },
    ],
  },
  {
    propId: "event_time",
    dataType: "DATETIME",
    source: "event_x",
    sqlExpr: "event_x.event_time",
    description: "事件时间",
  },
];
