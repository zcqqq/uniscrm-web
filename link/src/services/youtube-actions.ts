export type YouTubeActionResult = {
  ok: boolean;
  rateLimited?: boolean;
  rateLimitReset?: string;
  unauthorized?: boolean;
};

// Next midnight in America/Los_Angeles, expressed as a UTC ISO string. The YouTube Data API
// daily quota resets at midnight Pacific. The offset is computed at `now`; DST transitions
// exactly at midnight are an accepted edge case for a retry hint.
export function nextPacificMidnightISO(now: Date = new Date()): string {
  const ptNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const offsetMs = now.getTime() - ptNow.getTime();
  const ptMidnight = new Date(ptNow);
  ptMidnight.setHours(24, 0, 0, 0);
  return new Date(ptMidnight.getTime() + offsetMs).toISOString();
}

async function mapResponse(res: Response): Promise<YouTubeActionResult> {
  if (res.ok) return { ok: true };
  if (res.status === 401) return { ok: false, unauthorized: true };
  if (res.status === 403) {
    const body = await res.text().catch(() => "");
    if (body.includes("quotaExceeded")) {
      return { ok: false, rateLimited: true, rateLimitReset: nextPacificMidnightISO() };
    }
  }
  return { ok: false };
}

export async function rateVideo(accessToken: string, videoId: string): Promise<YouTubeActionResult> {
  const url = new URL("https://www.googleapis.com/youtube/v3/videos/rate");
  url.searchParams.set("id", videoId);
  url.searchParams.set("rating", "like");
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return mapResponse(res);
}

export async function insertPlaylistItem(accessToken: string, playlistId: string, videoId: string): Promise<YouTubeActionResult> {
  const res = await fetch("https://www.googleapis.com/youtube/v3/playlistItems?part=snippet", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } },
    }),
  });
  return mapResponse(res);
}
