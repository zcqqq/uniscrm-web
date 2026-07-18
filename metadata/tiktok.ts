// https://developers.tiktok.com/doc/tiktok-api-v2-video-list
import type { ContentMetadata } from "./dataTypes";

export const ContentMetadata_TikTok: ContentMetadata[] = [
  {
    sourceContentType: "video.list", // https://developers.tiktok.com/doc/tiktok-api-v2-video-list
    linkPrefix: "data.videos[]",
    contentProps: [
      { propId: "content_type", value: "VIDEO" },
      { propId: "source_content_id", dataId: "{linkPrefix}.id" },
      { propId: "source_created_at", dataId: "{linkPrefix}.create_time" },
      { propId: "cover_image_url", dataId: "{linkPrefix}.cover_image_url" },
      { propId: "content_text", dataId: "{linkPrefix}.video_description" },
      { propId: "duration", dataId: "{linkPrefix}.duration" },
      { propId: "height", dataId: "{linkPrefix}.height" },
      { propId: "width", dataId: "{linkPrefix}.width" },
      { propId: "title", dataId: "{linkPrefix}.title" },
      { propId: "like_count", dataId: "{linkPrefix}.like_count" },
      { propId: "reply_count", dataId: "{linkPrefix}.comment_count" },
      { propId: "share_count", dataId: "{linkPrefix}.share_count" },
      { propId: "view_count", dataId: "{linkPrefix}.view_count" },
    ],
  },
  {
    sourceContentType: "photo-post", // https://developers.tiktok.com/doc/content-posting-api-reference-photo-post
    flowType: "action",
    label: {"en":"Photo Posting", "zh":"发布图文"},
    description: {"en":"Generates images and a caption from the triggering content and posts as a TikTok draft.", "zh":"根据触发内容生成图片和文案，发布为TikTok草稿。"},
    contentProps: [
        {propId: "title", dataId:"post_info.title", aiType:"TEXT"},
        {propId: "description", dataId:"post_info.description", aiType:"TEXT"},
        {propId: "message_image", dataId:"source_info.photo_images[]", aiType:"IMAGE"},
    ],
  },
];
