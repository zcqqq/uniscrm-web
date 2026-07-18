const DATA_API_BASE = "https://www.googleapis.com/youtube/v3";
const HUB_URL = "https://pubsubhubbub.appspot.com/subscribe";

export function parseISO8601Duration(iso: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) return 0;
  const [, h, m, s] = match;
  return parseInt(h || "0", 10) * 3600 + parseInt(m || "0", 10) * 60 + parseInt(s || "0", 10);
}

export async function fetchVideoDetails(apiKey: string, videoId: string): Promise<Record<string, unknown> | null> {
  const apiUrl = new URL(`${DATA_API_BASE}/videos`);
  apiUrl.searchParams.set("part", "snippet,contentDetails,statistics");
  apiUrl.searchParams.set("id", videoId);
  apiUrl.searchParams.set("key", apiKey);

  const res = await fetch(apiUrl.toString());
  if (!res.ok) throw new Error(`YouTube videos.list failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { items?: Record<string, unknown>[] };
  return body.items?.[0] ?? null;
}

async function callHub(mode: "subscribe" | "unsubscribe", callbackUrl: string, youtubeChannelId: string): Promise<void> {
  const topic = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${youtubeChannelId}`;
  const body = new URLSearchParams({
    "hub.mode": mode,
    "hub.topic": topic,
    "hub.callback": callbackUrl,
    "hub.verify": "async",
  });
  const res = await fetch(HUB_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`WebSub ${mode} failed: ${res.status} ${await res.text()}`);
  }
}

export async function subscribeWebSub(callbackUrl: string, youtubeChannelId: string): Promise<void> {
  await callHub("subscribe", callbackUrl, youtubeChannelId);
}

export async function unsubscribeWebSub(callbackUrl: string, youtubeChannelId: string): Promise<void> {
  await callHub("unsubscribe", callbackUrl, youtubeChannelId);
}

export interface YouTubeSubscription {
  channelId: string;
  channelName: string;
  thumbnailUrl: string;
}

export async function fetchAllSubscriptions(accessToken: string): Promise<YouTubeSubscription[]> {
  const subscriptions: YouTubeSubscription[] = [];
  let pageToken: string | undefined;

  do {
    const apiUrl = new URL(`${DATA_API_BASE}/subscriptions`);
    apiUrl.searchParams.set("part", "snippet");
    apiUrl.searchParams.set("mine", "true");
    apiUrl.searchParams.set("maxResults", "50");
    if (pageToken) apiUrl.searchParams.set("pageToken", pageToken);

    const res = await fetch(apiUrl.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`YouTube subscriptions.list failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as {
      items?: { snippet?: { resourceId?: { channelId?: string }; title?: string; thumbnails?: { default?: { url?: string } } } }[];
      nextPageToken?: string;
    };

    for (const item of body.items || []) {
      const channelId = item.snippet?.resourceId?.channelId;
      if (!channelId) continue;
      subscriptions.push({
        channelId,
        channelName: item.snippet?.title || "",
        thumbnailUrl: item.snippet?.thumbnails?.default?.url || "",
      });
    }

    pageToken = body.nextPageToken;
  } while (pageToken);

  return subscriptions;
}
