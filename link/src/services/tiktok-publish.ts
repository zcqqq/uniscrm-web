export async function initPhotoPost(
  accessToken: string,
  photoUrls: string[],
  title: string,
  description: string
): Promise<{ ok: boolean; publishId?: string; rateLimited?: boolean; reason?: string }> {
  const res = await fetch("https://open.tiktokapis.com/v2/post/publish/content/init/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      media_type: "PHOTO",
      post_mode: "MEDIA_UPLOAD",
      post_info: { title, description },
      source_info: {
        source: "PULL_FROM_URL",
        photo_images: photoUrls,
        photo_cover_index: 0,
      },
    }),
  });

  const rawText = await res.text();
  let body: { data?: { publish_id?: string }; error?: { code: string; message: string } } | undefined;
  try {
    body = JSON.parse(rawText);
  } catch {
    body = undefined;
  }

  if (body === undefined) {
    // Body isn't parseable JSON at all — fall back to HTTP status.
    return { ok: false, reason: `tiktok_api_error: HTTP ${res.status}, unparseable response` };
  }

  const errorCode = body?.error?.code;
  if (errorCode === "rate_limit_exceeded") {
    return { ok: false, rateLimited: true };
  }
  if (!res.ok || (errorCode && errorCode !== "ok")) {
    const detail = [errorCode, body?.error?.message].filter(Boolean).join(" — ") || `HTTP ${res.status}`;
    return { ok: false, reason: `tiktok_api_error: ${detail}` };
  }

  return { ok: true, publishId: body?.data?.publish_id };
}

export async function initVideoPost(
  accessToken: string,
  videoUrl: string,
  title: string,
  description: string
): Promise<{ ok: boolean; publishId?: string; rateLimited?: boolean; reason?: string }> {
  const res = await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      post_info: { title, description },
      source_info: {
        source: "PULL_FROM_URL",
        video_url: videoUrl,
      },
    }),
  });

  const rawText = await res.text();
  let body: { data?: { publish_id?: string }; error?: { code: string; message: string } } | undefined;
  try {
    body = JSON.parse(rawText);
  } catch {
    body = undefined;
  }

  if (body === undefined) {
    return { ok: false, reason: `tiktok_api_error: HTTP ${res.status}, unparseable response` };
  }

  const errorCode = body?.error?.code;
  if (errorCode === "rate_limit_exceeded") {
    return { ok: false, rateLimited: true };
  }
  if (!res.ok || (errorCode && errorCode !== "ok")) {
    // TikTok's own code/message is the only thing that distinguishes (say) an unverified
    // PULL_FROM_URL domain from an expired token — dropping it here is what made every
    // TikTok failure indistinguishable in the analytics drawer.
    const detail = [errorCode, body?.error?.message].filter(Boolean).join(" — ") || `HTTP ${res.status}`;
    return { ok: false, reason: `tiktok_api_error: ${detail}` };
  }

  return { ok: true, publishId: body?.data?.publish_id };
}
