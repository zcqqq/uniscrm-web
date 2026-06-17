// https://docs.x.com/x-api/activity/introduction
import type { PropDefinition, EventMetadata } from "./dataTypes";

export const PROPS_X: PropDefinition[] = [
  {
    propId: "name",
    dataType: "TEXT",
    label: { en: "Name", zh: "名称" },
  },
  {
    propId: "username",
    dataType: "TEXT",
    label: { en: "Username", zh: "用户名" },
  },
  {
    propId: "followers_count",
    dataType: "INT",
    label: { en: "Followers", zh: "粉丝数" },
  },
  {
    propId: "following_count",
    dataType: "INT",
    label: { en: "Following", zh: "关注数" },
  },
  {
    propId: "verified_type",
    dataType: "ENUM",
    label: { en: "Verification Type", zh: "认证类型" },
    enums: [
      { value: "blue", label: { en: "Blue Verified", zh: "蓝V" } },
      { value: "none", label: { en: "None", zh: "无" } },
    ],
  },
];

export const METADATA_X: EventMetadata[] = [
  {
    eventType: "follow.follow",
    originalEventType: "follow.follow",
    linkPrefix: "target.data",
    flowType: "trigger",
    label: { en: "X Follow", zh: "X 关注" },
    description: { en: "Triggered when the channel follows someone on X", zh: "当频道在 X 上关注某人时触发" },
    userProps: [
      { propId: "name", dataId: "name" },
      { propId: "username", dataId: "username" },
    ],
    eventProps: [
      { propId: "followers_count", dataId: "public_metrics.followers_count" },
      { propId: "following_count", dataId: "public_metrics.following_count" },
      { propId: "verified_type", dataId: "verified_type" },
    ],
  },
  {
    eventType: "follow.followed",
    originalEventType: "follow.follow",
    linkPrefix: "source.data",
    flowType: "trigger",
    label: { en: "X Followed", zh: "X 被关注" },
    description: { en: "Triggered when someone follows the channel on X", zh: "当有人在 X 上关注频道时触发" },
    userProps: [
      { propId: "name", dataId: "name" },
      { propId: "username", dataId: "username" },
    ],
    eventProps: [
      { propId: "followers_count", dataId: "public_metrics.followers_count" },
      { propId: "following_count", dataId: "public_metrics.following_count" },
      { propId: "verified_type", dataId: "verified_type" },
    ],
  },
  {
    eventType: "follow.unfollow",
    originalEventType: "follow.unfollow",
    linkPrefix: "target.data",
    flowType: "trigger",
    label: { en: "X Unfollow", zh: "X 取关" },
    description: { en: "Triggered when the channel unfollows someone on X", zh: "当频道在 X 上取关某人时触发" },
    userProps: [
      { propId: "name", dataId: "name" },
      { propId: "username", dataId: "username" },
    ],
    eventProps: [
      { propId: "followers_count", dataId: "public_metrics.followers_count" },
      { propId: "following_count", dataId: "public_metrics.following_count" },
      { propId: "verified_type", dataId: "verified_type" },
    ],
  },
  {
    eventType: "follow.unfollowed",
    originalEventType: "follow.unfollowed",
    linkPrefix: "source.data",
    flowType: "trigger",
    label: { en: "X Unfollowed", zh: "X 被取关" },
    description: { en: "Triggered when someone unfollows the channel on X", zh: "当有人在 X 上取关频道时触发" },
    userProps: [
      { propId: "name", dataId: "name" },
      { propId: "username", dataId: "username" },
    ],
    eventProps: [
      { propId: "followers_count", dataId: "public_metrics.followers_count" },
      { propId: "following_count", dataId: "public_metrics.following_count" },
      { propId: "verified_type", dataId: "verified_type" },
    ],
  },
  {
    eventType: "follow-user", // https://docs.x.com/x-api/users/follow-user
    flowType: "action",
    label: { en: "Follow", zh: "关注" },
    userProps: [
    ],
    eventProps: [
    ],
  },
  {
    eventType: "unfollow-user", // https://docs.x.com/x-api/users/unfollow-user
    flowType: "action",
    label: { en: "Unfollow", zh: "取关" },
    userProps: [
    ],
    eventProps: [
    ],
  },
  {
    eventType: "chat.received",
    originalEventType: "chat.received",
    linkPrefix: "",
    label: { en: "X Chat Received", zh: "X 收到聊天" },
    description: { en: "Triggered when a DM is received", zh: "当收到li时触发" },
    userProps: [],
    eventProps: [],
  },
];
