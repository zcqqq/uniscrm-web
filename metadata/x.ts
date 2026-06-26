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
    propId: "verified_type",
    dataType: "ENUM",
    label: { en: "Verification Type", zh: "认证类型" },
    enums: [
      { value: "blue", label: { en: "Blue Verified", zh: "蓝V" } },
      { value: "none", label: { en: "None", zh: "无" } },
    ],
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
    propId: "tweet_count",
    dataType: "INT",
    label: { en: "Tweets", zh: "发帖数" },
  },
  {
    propId: "listed_count",
    dataType: "INT",
    label: { en: "Lists", zh: "收藏数" },
  },
  {
    propId: "like_count",
    dataType: "INT",
    label: { en: "Likes", zh: "点赞数" },
  },
  {
    propId: "media_count",
    dataType: "INT",
    label: { en: "Medias", zh: "多媒体数" },
  },
  {
    propId: "message_text",
    dataType: "TEXT",
    label: { en: "Message text", zh: "消息文本" },
  },
];

export const METADATA_X: EventMetadata[] = [
  {
    eventType: "follow.follow",
    originalEventType: "follow.follow",
    linkPrefix: "target.data",
    flowType: "trigger",
    label: { en: "Follow", zh: "关注" },
    description: { en: "Triggered when the Account follows someone", zh: "当账号关注某人时触发" },
   userProps: [
      { propId: "name", dataId: "{linkPrefix}.name" },
      { propId: "username", dataId: "{linkPrefix}.username" },
    ],
    eventProps: [
      { propId: "followers_count", dataId: "{linkPrefix}.public_metrics.followers_count" },
      { propId: "following_count", dataId: "{linkPrefix}.public_metrics.following_count" },
      { propId: "verified_type", dataId: "{linkPrefix}.verified_type" },
    ],
  },
  {
    eventType: "follow.followed",
    originalEventType: "follow.follow",
    linkPrefix: "source.data",
    flowType: "trigger",
    label: { en: "Followed", zh: "被关注" },
    description: { en: "Triggered when someone follows the Account", zh: "当有人关注账号时触发" },
    userProps: [
      { propId: "name", dataId: "{linkPrefix}.name" },
      { propId: "username", dataId: "{linkPrefix}.username" },
    ],
    eventProps: [
      { propId: "followers_count", dataId: "{linkPrefix}.public_metrics.followers_count" },
      { propId: "following_count", dataId: "{linkPrefix}.public_metrics.following_count" },
      { propId: "verified_type", dataId: "{linkPrefix}.verified_type" },
    ],
  },
  {
    eventType: "follow.unfollow",
    originalEventType: "follow.unfollow",
    linkPrefix: "target.data",
    flowType: "trigger",
    label: { en: "Unfollow", zh: "取关" },
    description: { en: "Triggered when the Account unfollows someone", zh: "当账号取关某人时触发" },
    userProps: [
      { propId: "name", dataId: "{linkPrefix}.name" },
      { propId: "username", dataId: "{linkPrefix}.username" },
    ],
    eventProps: [
      { propId: "followers_count", dataId: "{linkPrefix}.public_metrics.followers_count" },
      { propId: "following_count", dataId: "{linkPrefix}.public_metrics.following_count" },
      { propId: "verified_type", dataId: "{linkPrefix}.verified_type" },
    ],
  },
  {
    eventType: "follow.unfollowed",
    originalEventType: "follow.unfollowed",
    linkPrefix: "source.data",
    flowType: "trigger",
    label: { en: "Unfollowed", zh: "被取关" },
    description: { en: "Triggered when someone unfollows the Account", zh: "当有人取关账号时触发" },
    userProps: [
      { propId: "name", dataId: "{linkPrefix}.name" },
      { propId: "username", dataId: "{linkPrefix}.username" },
    ],
    eventProps: [
      { propId: "followers_count", dataId: "{linkPrefix}.public_metrics.followers_count" },
      { propId: "following_count", dataId: "{linkPrefix}.public_metrics.following_count" },
      { propId: "verified_type", dataId: "{linkPrefix}.verified_type" },
    ],
  },
  {
    eventType: "dm.read",
    originalEventType: "dm.read",
    linkPrefix: "users.{direct_message_events[].initiating_user_id}.data",
    flowType: "trigger",
    label: { en: "Direct Message read", zh: "私信已读" },
    description: { en: "Triggered when someone read a Direct Message", zh: "当有人读私信时触发" },
    userProps: [
      { propId: "name", dataId: "{linkPrefix}.name" },
      { propId: "username", dataId: "{linkPrefix}.username" },
      { propId: "verified_type", dataId: "{linkPrefix}.verified_type" },
      { propId: "followers_count", dataId: "{linkPrefix}.public_metrics.followers_count" },
      { propId: "following_count", dataId: "{linkPrefix}.public_metrics.following_count" },
      { propId: "tweet_count", dataId: "{linkPrefix}.public_metrics.tweet_count" },
      { propId: "listed_count", dataId: "{linkPrefix}.public_metrics.listed_count" },
      { propId: "like_count", dataId: "{linkPrefix}.public_metrics.like_count" },
      { propId: "media_count", dataId: "{linkPrefix}.public_metrics.media_count" },
    ],
    eventProps: [
    ],
  },
  {
    eventType: "dm.received",
    originalEventType: "dm.received",
    linkPrefix: "users.{direct_message_events[].message_create.sender_id}.data",
    flowType: "trigger",
    label: { en: "Direct Message received", zh: "收到私信" },
    description: { en: "Triggered when received a Direct Message from someone", zh: "当收到某人的私信时触发" },
    userProps: [
      { propId: "name", dataId: "{linkPrefix}.name" },
      { propId: "username", dataId: "{linkPrefix}.username" },
      { propId: "verified_type", dataId: "{linkPrefix}.verified_type" },
      { propId: "followers_count", dataId: "{linkPrefix}.public_metrics.followers_count" },
      { propId: "following_count", dataId: "{linkPrefix}.public_metrics.following_count" },
      { propId: "tweet_count", dataId: "{linkPrefix}.public_metrics.tweet_count" },
      { propId: "listed_count", dataId: "{linkPrefix}.public_metrics.listed_count" },
      { propId: "like_count", dataId: "{linkPrefix}.public_metrics.like_count" },
      { propId: "media_count", dataId: "{linkPrefix}.public_metrics.media_count" },
    ],
    eventProps: [
      { propId: "message_text", dataId: "direct_message_events[].message_create.message_data.text" },
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
    eventType: "create-dm", // https://docs.x.com/x-api/direct-messages/create-dm-message-by-participant-id
    flowType: "action",
    label: { en: "Direct message", zh: "发私信" },
    userProps: [
    ],
    eventProps: [
      { propId: "message_text", dataId: "text" },
    ],
  },
  {
    eventType: "mute-user", // https://docs.x.com/x-api/users/mute-user
    flowType: "action",
    label: { en: "Mute", zh: "隐藏" },
    userProps: [
    ],
    eventProps: [
    ],
  },
];
