export async function initPhotoPost(
  accessToken: string,
  photoUrls: string[],
  title: string,
  description: string
): Promise<{ ok: boolean; publishId?: string; rateLimited?: boolean }> {
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

  const errorCode = body?.error?.code;
  if (errorCode === "rate_limit_exceeded") {
    return { ok: false, rateLimited: true };
  }
  if (!res.ok || (errorCode && errorCode !== "ok")) {
    return { ok: false };
  }

  return { ok: true, publishId: body?.data?.publish_id };
}
