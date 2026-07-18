const DATA_API_BASE = "https://www.googleapis.com/youtube/v3";
const HUB_URL = "https://pubsubhubbub.appspot.com/subscribe";

export function parseISO8601Duration(iso: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) return 0;
  const [, h, m, s] = match;
  return parseInt(h || "0", 10) * 3600 + parseInt(m || "0", 10) * 60 + parseInt(s || "0", 10);
}

export interface YouTubeChannelResolution {
  channelId: string;
  channelName: string;
  thumbnailUrl: string;
}

// Best-effort URL parsing: direct /channel/UC... IDs need no API call. @handle URLs (and bare
// @handle input) resolve via channels.list?forHandle. /c/CustomName and /user/LegacyName URLs
// are not resolved (YouTube's forHandle/forUsername params don't reliably cover custom URLs) —
// flagged here as a known v1 gap rather than silently mishandled.
export async function resolveYouTubeChannelId(apiKey: string, url: string): Promise<YouTubeChannelResolution | null> {
  const channelIdMatch = /\/channel\/(UC[\w-]+)/.exec(url);
  if (channelIdMatch) {
    // Direct /channel/UC... IDs need no API call — the ID is already in the URL.
    return { channelId: channelIdMatch[1], channelName: "", thumbnailUrl: "" };
  }

  const handleMatch = /@([\w.-]+)/.exec(url);
  if (handleMatch) {
    return fetchChannelByHandle(apiKey, handleMatch[1]);
  }

  return null;
}

async function fetchChannelByHandle(apiKey: string, handle: string): Promise<YouTubeChannelResolution | null> {
  const apiUrl = new URL(`${DATA_API_BASE}/channels`);
  apiUrl.searchParams.set("part", "snippet");
  apiUrl.searchParams.set("forHandle", `@${handle}`);
  apiUrl.searchParams.set("key", apiKey);
  return runChannelLookup(apiUrl);
}

// Backfill for the direct /channel/UC... resolution path in resolveYouTubeChannelId, which
// returns channelName/thumbnailUrl as "" since no API call is needed to get the ID itself.
// Callers that need display info for a channelId obtained that way should call this once,
// after resolution, rather than resolveYouTubeChannelId doing a redundant lookup by ID for
// every /channel/ URL (most callers only need the ID).
export async function fetchChannelSnippet(apiKey: string, channelId: string): Promise<{ channelName: string; thumbnailUrl: string } | null> {
  const apiUrl = new URL(`${DATA_API_BASE}/channels`);
  apiUrl.searchParams.set("part", "snippet");
  apiUrl.searchParams.set("id", channelId);
  apiUrl.searchParams.set("key", apiKey);
  const result = await runChannelLookup(apiUrl);
  if (!result) return null;
  return { channelName: result.channelName, thumbnailUrl: result.thumbnailUrl };
}

async function runChannelLookup(apiUrl: URL): Promise<YouTubeChannelResolution | null> {
  const res = await fetch(apiUrl.toString());
  if (!res.ok) throw new Error(`YouTube channels.list failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    items?: { id: string; snippet?: { title?: string; thumbnails?: { default?: { url?: string } } } }[];
  };
  const item = body.items?.[0];
  if (!item) return null;
  return {
    channelId: item.id,
    channelName: item.snippet?.title || "",
    thumbnailUrl: item.snippet?.thumbnails?.default?.url || "",
  };
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
