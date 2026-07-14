import { TikTokUnauthorizedError } from "./tiktok-errors";

// https://developers.tiktok.com/doc/tiktok-api-v2-video-list
const VIDEO_FIELDS = [
  "id",
  "video_description",
  "create_time",
  "cover_image_url",
  "duration",
  "height",
  "width",
  "title",
  "like_count",
  "comment_count",
  "share_count",
  "view_count",
].join(",");

export interface TikTokVideoPage {
  data: Record<string, unknown>[];
  nextCursor?: number;
  hasMore: boolean;
}

export interface TikTokVideoFetchResult {
  page: TikTokVideoPage;
  rateLimited: boolean;
}

export async function fetchVideoListPage(
  accessToken: string,
  cursor?: number
): Promise<TikTokVideoFetchResult> {
  const url = new URL("https://open.tiktokapis.com/v2/video/list/");
  url.searchParams.set("fields", VIDEO_FIELDS);

  const body: Record<string, unknown> = { max_count: 20 };
  if (cursor !== undefined) body.cursor = cursor;

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`TikTok video.list failed: ${res.status} ${await res.text()}`);
  }

  const responseBody = (await res.json()) as {
    data?: { videos?: Record<string, unknown>[]; cursor?: number; has_more?: boolean };
    error?: { code: string; message: string };
  };

  const errorCode = responseBody.error?.code;
  if (errorCode === "rate_limit_exceeded") {
    return { page: { data: [], hasMore: false }, rateLimited: true };
  }
  if (errorCode === "access_token_invalid") {
    throw new TikTokUnauthorizedError(`TikTok video.list failed: ${errorCode} ${responseBody.error?.message ?? ""}`);
  }
  if (errorCode && errorCode !== "ok") {
    throw new Error(`TikTok video.list failed: ${errorCode} ${responseBody.error?.message ?? ""}`);
  }

  return {
    page: {
      data: responseBody.data?.videos || [],
      nextCursor: responseBody.data?.cursor,
      hasMore: responseBody.data?.has_more || false,
    },
    rateLimited: false,
  };
}
