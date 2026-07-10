// https://docs.x.com/x-api/activity/introduction
import type { PropDefinition, EventMetadata, ContentMetadata } from "./dataTypes";

export const PROPS_X: PropDefinition[] = [
  {
    propId: "source_user_id",
    dataType: "TEXT",
    label: { en: "source user id", zh: "源 user id" },
  },
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
    propId: "is_follow",
    isInsight: true,
    dataType: "ENUM_INT",
    label: { en: "Is following", zh: "是否关注" },
    enums: [
      { value: 0, label: { en: "Not following", zh: "未关注" } },
      { value: 1, label: { en: "Following", zh: "关注中" } },
    ],
  },
  {
    propId: "is_followed",
    isInsight: true,
    dataType: "ENUM_INT",
    label: { en: "Is followed", zh: "是否被关注" },
    enums: [
      { value: 0, label: { en: "Not followed", zh: "未被关注" } },
      { value: 1, label: { en: "Followed", zh: "被关注中" } },
    ],
  },
  {
    propId: "verified_type",
    isInsight: true,
    dataType: "ENUM_TEXT",
    label: { en: "Verification Type", zh: "认证类型" },
    enums: [
      { value: "blue", label: { en: "Blue Verified", zh: "蓝V" } },
      { value: "none", label: { en: "None", zh: "无" } },
    ],
  },
  {
    propId: "followers_count",
        isInsight: true,
    dataType: "INT",
    label: { en: "Followers", zh: "粉丝数" },
  },
  {
    propId: "following_count",
        isInsight: true,
    dataType: "INT",
    label: { en: "Following", zh: "关注数" },
  },
  {
    propId: "tweet_count",
        isInsight: true,
    dataType: "INT",
    label: { en: "Tweets", zh: "发帖数" },
  },
  {
    propId: "listed_count",
        isInsight: true,
    dataType: "INT",
    label: { en: "Lists", zh: "收藏数" },
  },
  {
    propId: "like_count",
        isInsight: true,
    dataType: "INT",
    label: { en: "Likes", zh: "点赞数" },
  },
  {
    propId: "media_count",
        isInsight: true,
    dataType: "INT",
    label: { en: "Medias", zh: "多媒体数" },
  },
  {
    propId: "message_text",
        isInsight: true,
    dataType: "TEXT",
    label: { en: "Message text", zh: "消息文本" },
  },
];

export const EventMetadata_X: EventMetadata[] = [
  {
    eventType: "follow.follow",
    sourceEventType: "follow.follow",
    linkPrefix: "target.data",
    flowType: "trigger",
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
    sourceEventType: "dm.received",
    linkPrefix: "users.{direct_message_events[].message_create.sender_id}.data",
    flowType: "trigger",
    label: { en: "Direct Message received", zh: "收到私信" },
    description: { en: "Triggered when received a Direct Message from someone", zh: "当收到某人的私信时触发" },
    userProps: [
                { propId: "source_user_id", dataId: "{linkPrefix}.id" },
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
    eventType: "post.create",
    sourceEventType: "post.create",
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
      { propId: "is_follow", value: 0 },
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
      { propId: "is_follow", value: 1 },
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

export const ContentMetadata_X: ContentMetadata[] = [
  {
    contentType: "post.create",
    sourceContentType: "post.create",
  },
  {
    contentType: "post.delete",
    sourceContentType: "post.delete",
  },
]

export const XAA_SUBSCRIPTION_EVENTS = [...new Set(
  EventMetadata_X
    .filter(e => e.flowType !== "action")
    .map(e => e.sourceEventType)
)];

