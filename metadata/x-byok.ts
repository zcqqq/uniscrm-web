// https://docs.x.com/x-api/activity/introduction
import type { PropDefinition, UserMetadata } from "./dataTypes";

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

export const UserMetadata_X: UserMetadata[] = [
  {
    sourceUserType: "get-followers", // https://docs.x.com/x-api/users/get-followers
    linkPrefix: "data[]",
    userProps: [
      { propId: "source_user_id", dataId: "{linkPrefix}.id" },
      { propId: "name", dataId: "{linkPrefix}.name" },
      { propId: "username", dataId: "{linkPrefix}.username" },
      { propId: "is_followed", value: 1 },
    ],
  },
];
