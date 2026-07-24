// https://docs.x.com/x-api/activity/introduction
import type { EventMetadata, ContentMetadata } from "./dataTypes";

export const EventMetadata_X: EventMetadata[] = [
  {
    eventType: "follow.follow",
    sourceEventType: "follow.follow",
    linkPrefix: "target.data",
    flowType: "trigger",
    price: 0.010,
    label: { en: "Follow", zh: "关注" },
    description: { en: "Triggered when the Account follows someone", zh: "当账号关注某人时触发" },
    userProps: [
      { propId: "source_user_id", dataId: "{linkPrefix}.id" },
      { propId: "name", dataId: "{linkPrefix}.name" },
      { propId: "username", dataId: "{linkPrefix}.username" },
      { propId: "is_follow", value: 1 },
    ],
    eventProps: [
      { propId: "followers_count", dataId: "{linkPrefix}.public_metrics.followers_count" },
      { propId: "following_count", dataId: "{linkPrefix}.public_metrics.following_count" },
      { propId: "verified_type", dataId: "{linkPrefix}.verified_type" },
    ],
  },
  {
    eventType: "follow.followed",
    sourceEventType: "follow.follow",
    linkPrefix: "source.data",
    flowType: "trigger",
    price: 0.010,
    label: { en: "Followed", zh: "被关注" },
    description: { en: "Triggered when someone follows the Account", zh: "当有人关注账号时触发" },
    userProps: [
      { propId: "source_user_id", dataId: "{linkPrefix}.id" },
      { propId: "name", dataId: "{linkPrefix}.name" },
      { propId: "username", dataId: "{linkPrefix}.username" },
      { propId: "is_followed", value: 1 },
    ],
    eventProps: [
      { propId: "followers_count", dataId: "{linkPrefix}.public_metrics.followers_count" },
      { propId: "following_count", dataId: "{linkPrefix}.public_metrics.following_count" },
      { propId: "verified_type", dataId: "{linkPrefix}.verified_type" },
    ],
  },
  {
    eventType: "follow.unfollow",
    sourceEventType: "follow.unfollow",
    linkPrefix: "target.data",
    flowType: "trigger",
    price: 0.010,
    label: { en: "Unfollow", zh: "取关" },
    description: { en: "Triggered when the Account unfollows someone", zh: "当账号取关某人时触发" },
    userProps: [
      { propId: "source_user_id", dataId: "{linkPrefix}.id" },
      { propId: "name", dataId: "{linkPrefix}.name" },
      { propId: "username", dataId: "{linkPrefix}.username" },
      { propId: "is_follow", value: 0 },
    ],
    eventProps: [
      { propId: "followers_count", dataId: "{linkPrefix}.public_metrics.followers_count" },
      { propId: "following_count", dataId: "{linkPrefix}.public_metrics.following_count" },
      { propId: "verified_type", dataId: "{linkPrefix}.verified_type" },
    ],
  },
  {
    eventType: "follow.unfollowed",
    sourceEventType: "follow.unfollow",
    linkPrefix: "source.data",
    flowType: "trigger",
    price: 0.010,
    label: { en: "Unfollowed", zh: "被取关" },
    description: { en: "Triggered when someone unfollows the Account", zh: "当有人取关账号时触发" },
    userProps: [
      { propId: "source_user_id", dataId: "{linkPrefix}.id" },
      { propId: "name", dataId: "{linkPrefix}.name" },
      { propId: "username", dataId: "{linkPrefix}.username" },
      { propId: "is_followed", value: 0 },
    ],
    eventProps: [
      { propId: "followers_count", dataId: "{linkPrefix}.public_metrics.followers_count" },
      { propId: "following_count", dataId: "{linkPrefix}.public_metrics.following_count" },
      { propId: "verified_type", dataId: "{linkPrefix}.verified_type" },
    ],
  },
  {
    eventType: "dm.read",
    sourceEventType: "dm.read",
    linkPrefix: "users.{direct_message_events[].initiating_user_id}.data",
    flowType: "trigger",
    label: { en: "Direct Message read", zh: "私信已读" },
    description: { en: "Triggered when someone read a Direct Message", zh: "当有人读私信时触发" },
    userProps: [
      { propId: "source_user_id", dataId: "{linkPrefix}.id" },
      { propId: "name", dataId: "{linkPrefix}.name" },
      { propId: "username", dataId: "{linkPrefix}.username" },
      { propId: "verified_type", dataId: "{linkPrefix}.verified_type" },
      { propId: "followers_count", dataId: "{linkPrefix}.public_metrics.followers_count" },
      { propId: "following_count", dataId: "{linkPrefix}.public_metrics.following_count" },
      { propId: "post_count", dataId: "{linkPrefix}.public_metrics.tweet_count" },
      { propId: "listed_count", dataId: "{linkPrefix}.public_metrics.listed_count" },
      { propId: "like_count", dataId: "{linkPrefix}.public_metrics.like_count" },
      { propId: "media_count", dataId: "{linkPrefix}.public_metrics.media_count" },
    ],
    eventProps: [
    ],
  },
  {
    eventType: "dm.received",
    sourceEventType: "dm.received",
    linkPrefix: "users.{direct_message_events[].message_create.sender_id}.data",
    flowType: "trigger",
    price: 0.010,
    label: { en: "Direct Message received", zh: "收到私信" },
    description: { en: "Triggered when received a Direct Message from someone", zh: "当收到某人的私信时触发" },
    userProps: [
      { propId: "source_user_id", dataId: "{linkPrefix}.id" },
      { propId: "name", dataId: "{linkPrefix}.name" },
      { propId: "username", dataId: "{linkPrefix}.username" },
      { propId: "verified_type", dataId: "{linkPrefix}.verified_type" },
      { propId: "followers_count", dataId: "{linkPrefix}.public_metrics.followers_count" },
      { propId: "following_count", dataId: "{linkPrefix}.public_metrics.following_count" },
      { propId: "post_count", dataId: "{linkPrefix}.public_metrics.tweet_count" },
      { propId: "listed_count", dataId: "{linkPrefix}.public_metrics.listed_count" },
      { propId: "like_count", dataId: "{linkPrefix}.public_metrics.like_count" },
      { propId: "media_count", dataId: "{linkPrefix}.public_metrics.media_count" },
    ],
    eventProps: [
      { propId: "message_text", dataId: "direct_message_events[].message_create.message_data.text" },
    ],
  },
  {
    eventType: "post.create",
    sourceEventType: "post.create",
    price: 0.005,
    label: { en: "Created a post", zh: "发帖" },
    userProps: [],
    eventProps: [],
  },
  {
    eventType: "like.create",
    sourceEventType: "like.create",
    label: { en: "Liked a post", zh: "点赞" },
    userProps: [],
    eventProps: [],
  },
  {
    eventType: "follow-user", // https://docs.x.com/x-api/users/follow-user
    sourceEventType: "follow-user",
    flowType: "action",
    price: 0.015,
    label: { en: "Follow", zh: "关注" },
    userProps: [],
    userPropsFilter: [
      { propId: "is_follow", operator: "==", value: 0 },
    ],
    eventProps: [],
  },
  {
    eventType: "unfollow-user", // https://docs.x.com/x-api/users/unfollow-user
    sourceEventType: "unfollow-user",
    flowType: "action",
    price: 0.010,
    label: { en: "Unfollow", zh: "取关" },
    userProps: [],
    userPropsFilter: [
      { propId: "is_follow", operator: "==", value: 1 },
    ],
    eventProps: [],
  },
  {
    eventType: "create-dm", // https://docs.x.com/x-api/direct-messages/create-dm-message-by-participant-id
    sourceEventType: "create-dm",
    flowType: "action",
    price: 0.015,
    label: { en: "Direct message", zh: "发私信" },
    userProps: [
    ],
    eventProps: [
      { propId: "message_text", dataId: "text" },
    ],
  },
  {
    eventType: "mute-user", // https://docs.x.com/x-api/users/mute-user
    sourceEventType: "mute-user",
    flowType: "action",
    price: 0.010,
    label: { en: "Mute", zh: "隐藏" },
    userProps: [
    ],
    eventProps: [
    ],
  },
];

export const XAA_SUBSCRIPTION_EVENTS = [...new Set(
  EventMetadata_X
    .filter(e => e.flowType !== "action")
    .map(e => e.sourceEventType)
)];

