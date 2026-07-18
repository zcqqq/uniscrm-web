// https://developers.google.com/youtube/v3/docs/videos/list
import type { ContentMetadata } from "./dataTypes";

export const ContentMetadata_YouTube: ContentMetadata[] = [
  {
    sourceContentType: "watch:get-videos", // https://developers.google.com/youtube/v3/docs/videos/list
    linkPrefix: "items[]",
    contentProps: [
      { propId: "content_type", value: "VIDEO" },
      { propId: "source_content_id", dataId: "{linkPrefix}.id" },
      { propId: "source_created_at", dataId: "{linkPrefix}.snippet.publishedAt" },
      { propId: "title", dataId: "{linkPrefix}.snippet.title" },
      { propId: "content_text", dataId: "{linkPrefix}.snippet.description" },
      { propId: "cover_image_url", dataId: "{linkPrefix}.snippet.thumbnails.default.url" },
      { propId: "view_count", dataId: "{linkPrefix}.statistics.viewCount" },
      { propId: "like_count", dataId: "{linkPrefix}.statistics.likeCount" },
      // duration and has_face are computed (not resolveProps-mapped) — declared here with
      // no dataId/value purely so the flow Inspector's ConditionsEditor field list includes
      // them (see getContentTriggerFields in Task 10). resolveProps skips entries with
      // neither `value` nor `dataId`, so these are safe no-ops during ingestion mapping.
      { propId: "duration" },
      { propId: "has_face" },
    ],
  },
];
