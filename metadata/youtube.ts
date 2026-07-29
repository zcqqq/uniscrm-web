// https://developers.google.com/youtube/v3/docs/videos/list
import type { ContentMetadata, UserMetadata } from "./dataTypes";

export const ContentMetadata_YouTube: ContentMetadata[] = [
  {
    sourceContentType: "watch:get-videos", // https://developers.google.com/youtube/v3/docs/videos/list subscriptions.list
    flowType: "trigger",
    linkPrefix: "items[]",
    label: { "en": "Subscription Videos", "zh": "订阅的视频" },
    contentProps: [
      { propId: "content_type", value: "VIDEO" },
      { propId: "source_content_id", dataId: "{linkPrefix}.id" },
      { propId: "source_created_at", dataId: "{linkPrefix}.snippet.publishedAt" },
      { propId: "title", dataId: "{linkPrefix}.snippet.title" },
      { propId: "content_text", dataId: "{linkPrefix}.snippet.description" },
      { propId: "cover_image_url", dataId: "{linkPrefix}.snippet.thumbnails.default.url" },
      { propId: "view_count", dataId: "{linkPrefix}.statistics.viewCount" },
      { propId: "like_count", dataId: "{linkPrefix}.statistics.likeCount" },
      // duration is computed (not resolveProps-mapped) — declared here with no dataId/value
      // purely so the flow Inspector's ConditionsEditor field list includes it (see
      // getContentTriggerFields). resolveProps skips entries with neither `value` nor
      // `dataId`, so this is a safe no-op during ingestion mapping.
      { propId: "duration" },
    ],
    // 系统级限制：只有 <=xxx 秒的视频才触发 content flow（link 端入队前拦截）。
    contentPropsFilter: [
      { propId: "duration", operator: "<=", value: 600 },
    ],
  },
  {
    sourceContentType: "save-to-playlist", // https://developers.google.com/youtube/v3/docs/playlistItems/insert
    flowType: "action",
    // 无price：YouTube Data API不按调用收费，是免费配额制（10,000 units/天，无付费档，
    // 只能走免费的审核提额）。写操作各消耗50 units，属配额成本而非官方费用。
    label: { "en": "Save to Playlist", "zh": "加入播放列表" },
    description: { "en": "Adds the video to a playlist via the triggering channel", "zh": "通过触发该内容的账号把视频加入播放列表" },
    contentProps: [],
  },
  {
    sourceContentType: "rate-like", // https://developers.google.com/youtube/v3/docs/videos/rate
    flowType: "action",
    // 无price：理由同save-to-playlist（YouTube免费配额制，非按调用收费）。
    label: { "en": "Like", "zh": "点赞" },
    description: { "en": "Likes the video via the triggering channel", "zh": "通过触发该内容的账号给视频点赞" },
    contentProps: [],
  },
];

// 订阅的频道 = user 实体，对齐 X 的 follow user（我订阅他们 → is_follow = 1）。
// 数据来自 channels.list?part=snippet,statistics 的单条 item，不是 subscriptions.list ——
// subscriptions.list 任何 part 都不含被订阅频道的订阅数（已核对官方文档）。
// 无 linkPrefix：调用方逐条喂 item，不是整个响应体。
export const UserMetadata_YouTube: UserMetadata[] = [
  {
    sourceUserType: "own:get-subscriptions", // https://developers.google.com/youtube/v3/docs/channels/list
    userProps: [
      { propId: "source_user_id", dataId: "id" }, // UC... 频道 ID
      { propId: "name", dataId: "snippet.title" },
      { propId: "username", dataId: "snippet.customUrl" }, // 形如 @mkbhd
      { propId: "description", dataId: "snippet.description" },
      { propId: "profile_image_url", dataId: "snippet.thumbnails.default.url" },
      // subscriberCount 官方四舍五入到 3 位有效数字；这是唯一能拿到的数。
      // hiddenSubscriberCount = true 时该字段缺席，下游保持 null 而不是写 0。
      { propId: "followers_count", dataId: "statistics.subscriberCount" },
      { propId: "post_count", dataId: "statistics.videoCount" },
      { propId: "is_follow", value: 1 },
    ],
  },
];
