// 跨平台共享的 prop registry：所有平台（X、TikTok 等）都注册进同一个数组，
// 复用 definePropDefinitions 的编译期 propId 去重检查（见 dataTypes.ts）。
import { definePropDefinitions } from "./dataTypes";

export const PROPS = definePropDefinitions([
  {
    propId: "user_id", //用于content commerce等与USER表关联
    dataType: "TEXT",
    isList: false,
    label: { en: "user id", zh: "user id" },
  },
  {
    propId: "source_user_id",
    dataType: "TEXT",
    isList: false,
    label: { en: "source user id", zh: "源 user id" },
  },
  {
    propId: "name",
    dataType: "TEXT",
    entity: ["user"],
    label: { en: "Name", zh: "名称" },
  },
  {
    propId: "username",
    dataType: "TEXT",
    entity: ["user"],
    label: { en: "Username", zh: "用户名" },
  },
  {
    propId: "is_follow",
    isInsight: true,
    dataType: "ENUM_INT",
    entity: ["user"],
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
    entity: ["user"],
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
    propId: "description",
    isList: false,
    dataType: "TEXT",
    entity: ["user"],
    label: { en: "Description", zh: "描述" },
  },
  {
    propId: "profile_image_url",
    dataType: "TEXT",
    fieldType: "IMAGE",
    entity: ["user"],
    label: { en: "Avatar", zh: "头像" },
  },
  {
    propId: "followers_count",
    isInsight: true,
    dataType: "INT",
    entity: ["user"],
    label: { en: "Followers", zh: "粉丝数" },
  },
  {
    propId: "following_count",
    isInsight: true,
    dataType: "INT",
    entity: ["user"],
    label: { en: "Following", zh: "关注数" },
  },
  {
    propId: "post_count",
    isInsight: true,
    dataType: "INT",
    entity: ["user"],
    label: { en: "Posts", zh: "发帖数" },
  },
  {
    propId: "listed_count",
    isInsight: true,
    dataType: "INT",
    entity: ["user"],
    label: { en: "Lists", zh: "收藏数" },
  },
  {
    propId: "like_count",
    isInsight: true,
    dataType: "INT",
    entity: ["user", "content"],
    label: { en: "Likes", zh: "点赞数" },
  },
  {
    propId: "media_count",
    isInsight: true,
    dataType: "INT",
    entity: ["user"],
    label: { en: "Medias", zh: "多媒体数" },
  },
  {
    propId: "message_text",
    isInsight: true,
    dataType: "TEXT",
    label: { en: "Text", zh: "文本" },
  },
  {
    propId: "message_image",
    dataType: "IMAGE",
    label: { en: "Image", zh: "图片" },
  },
  {
    propId: "message_video",
    dataType: "VIDEO",
    label: { en: "Video", zh: "视频" },
  },
  {
    propId: "source_created_at",
    isInsight: true,
    dataType: "DATETIME",
    entity: ["content"],
    label: { en: "Posted at", zh: "发布时间" },
  },
  {
    propId: "source_content_id",
    dataType: "TEXT",
    isList: false,
    label: { en: "Source Content ID", zh: "源 Content ID" },
  },
  {
    propId: "content_type",
    isInsight: true,
    dataType: "ENUM_TEXT",
    entity: ["content"],
    label: { en: "Content Type", zh: "内容类型" },
    enums: [
      { value: "TWEET", label: { en: "Tweet", zh: "推文" } },
      { value: "ARTICLE", label: { en: "Article", zh: "文章" } },
      { value: "VIDEO", label: { en: "Video", zh: "视频" } },
      { value: "RELEASE", label: { en: "Release", zh: "发版" } },
    ],
  },
  {
    propId: "title",
    dataType: "TEXT",
    entity: ["content"],
    label: { en: "Title", zh: "标题" },
  },
  {
    propId: "content_text",
    dataType: "TEXT",
    entity: ["content"],
    label: { en: "Content Text", zh: "内容文本" },
  },
  {
    propId: "content_url",
    dataType: "TEXT",
    entity: ["content"],
    label: { en: "Content URL", zh: "内容链接" },
  },
  {
    propId: "cover_image_url",
    dataType: "TEXT",
    fieldType: "IMAGE",
    entity: ["content"],
    label: { en: "Cover", zh: "封面" },
  },
  {
    propId: "duration",
    isInsight: true,
    dataType: "INT",
    entity: ["content"],
    label: { en: "Duration", zh: "时长" },
  },
  // 下面三个是 flow-payload-only prop：由 content/src/queue-video-action.ts 产出、写进
  // flow payload，flow 侧用 $content.processed_video_url 之类的字符串引用消费
  // （flow/nodeTypeRegistry.ts、flow/src/index.ts）。它们**不是**任何快照表上的列，
  // 所以不带 entity（dataTypes.ts 的 entity 契约：entity = 表上的真实列）。曾经误标
  // entity:["content"]，导致 Content 列表渲染三个永远为空的死列；
  // analytics/tests/unit/content-stream-schema.test.ts 现在机器对账，加回 entity 而
  // 不加列会直接红。
  {
    propId: "processed_video_url",
    dataType: "TEXT",
    fieldType: "VIDEO",
    label: { en: "Subtitled Video", zh: "字幕视频" },
  },
  {
    propId: "video_transcript",
    dataType: "TEXT",
    label: { en: "Video Transcript", zh: "视频转录文本" },
  },
  {
    propId: "translated_subtitle_text",
    dataType: "TEXT",
    label: { en: "Translated Subtitle Text", zh: "翻译字幕文本" },
  },
  {
    propId: "height",
    isInsight: true,
    dataType: "INT",
    entity: ["content"],
    label: { en: "Height", zh: "高度" },
  },
  {
    propId: "width",
    isInsight: true,
    dataType: "INT",
    entity: ["content"],
    label: { en: "Width", zh: "宽度" },
  },
  // content 表的真实列（tenant-init-sql / content-stream-schema 都有它），此前只出现在
  // link 手抄的 CONTENT_COLUMN_MAP 里而不在 registry —— 注册进来让 metadata/columns.ts
  // 能完整推导。isList:false + 无 isInsight：不在 Content 列表和 analytics 选择器里展示，
  // 与注册前的 UI 行为逐字一致。
  {
    propId: "has_face",
    dataType: "INT",
    isList: false,
    entity: ["content"],
    label: { en: "Has Face", zh: "是否含人脸" },
  },
  {
    propId: "bookmark_count",
    isInsight: true,
    dataType: "INT",
    entity: ["content"],
    label: { en: "Bookmarks", zh: "收藏数" },
  },
  {
    propId: "view_count",
    isInsight: true,
    dataType: "INT",
    entity: ["content"],
    label: { en: "Views", zh: "浏览数" },
  },
  {
    propId: "quote_count",
    isInsight: true,
    dataType: "INT",
    entity: ["content"],
    label: { en: "Quotes", zh: "Quotes" },
  },
  {
    propId: "reply_count",
    isInsight: true,
    dataType: "INT",
    entity: ["content"],
    label: { en: "Replies", zh: "回复数" },
  },
  {
    propId: "repost_count",
    isInsight: true,
    dataType: "INT",
    entity: ["content"],
    label: { en: "Reposts", zh: "转发数" },
  },
  {
    propId: "share_count",
    isInsight: true,
    dataType: "INT",
    entity: ["content"],
    label: { en: "Shares", zh: "分享数" },
  },
  // --- GitHub release：全部是 flow-payload-only prop，不带 entity ---
  // 它们不是 user/content 快照表上的列，只在 content trigger 的 flow payload 里出现。
  // 加 entity 而不加列会被 analytics/tests/unit/content-stream-schema.test.ts 判红。
  {
    propId: "tag_name",
    dataType: "TEXT",
    label: { en: "Tag", zh: "标签" },
  },
  {
    propId: "is_prerelease",
    dataType: "ENUM_INT",
    label: { en: "Is Prerelease", zh: "是否预发布" },
    enums: [
      { value: 0, label: { en: "Stable", zh: "正式版" } },
      { value: 1, label: { en: "Prerelease", zh: "预发布" } },
    ],
  },
  // 三个窗口的发版数。值不在轮询时算 —— 计数口径跟随触发节点的 includePrerelease，
  // 而轮询按 repo 走、看不到节点配置。flow 侧 trigger 命中后从 release_history 算出来注入。
  {
    propId: "release_count_1d",
    dataType: "INT",
    label: { en: "Releases (24h)", zh: "24小时发版数" },
  },
  {
    propId: "release_count_7d",
    dataType: "INT",
    label: { en: "Releases (7d)", zh: "7天发版数" },
  },
  {
    propId: "release_count_30d",
    dataType: "INT",
    label: { en: "Releases (30d)", zh: "30天发版数" },
  },
]);
