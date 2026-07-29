const DATA_API_BASE = "https://www.googleapis.com/youtube/v3";

// channels.list 的 id 参数单次最多 50 个（官方文档）。分批是调用方的责任 ——
// 由调用方分批，才能在某一批失败时精确地知道「哪些频道本轮没更新」。
export const CHANNELS_BATCH_SIZE = 50;

// channels.list 的一条 item，原样交给 resolveProps。结构不在这里收窄：
// 未映射字段要完整留给 raw_data。
export interface YouTubeChannelItem {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    customUrl?: string;
    thumbnails?: { default?: { url?: string } };
    [k: string]: unknown;
  };
  statistics?: {
    subscriberCount?: string; // API 返回字符串
    videoCount?: string;
    viewCount?: string;
    hiddenSubscriberCount?: boolean;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

// 全量分页拉「我订阅了谁」。complete = false 表示走查被中断（分页失败或撞 deadline），
// 调用方据此**必须**跳过取消订阅的 diff —— 半份列表做 diff 会把仍在订阅的频道
// 误判成已取消。calls 是实际发出的请求数，供配额记账（1 unit/次）。
export async function fetchSubscribedChannelIds(
  accessToken: string,
  deadline: number
): Promise<{ ids: string[]; complete: boolean; calls: number }> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  let calls = 0;

  do {
    if (Date.now() >= deadline) {
      console.log(JSON.stringify({ event: "youtube_subscriptions_walk_deadline", calls, collected: ids.length }));
      return { ids, complete: false, calls };
    }

    const apiUrl = new URL(`${DATA_API_BASE}/subscriptions`);
    apiUrl.searchParams.set("part", "snippet");
    apiUrl.searchParams.set("mine", "true");
    apiUrl.searchParams.set("maxResults", "50");
    if (pageToken) apiUrl.searchParams.set("pageToken", pageToken);

    let body: {
      items?: { snippet?: { resourceId?: { channelId?: string } } }[];
      nextPageToken?: string;
    };
    try {
      const res = await fetch(apiUrl.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
      calls++;
      if (!res.ok) {
        console.error(JSON.stringify({
          event: "youtube_subscriptions_walk_error",
          status: res.status, body: await res.text().catch(() => ""), collected: ids.length,
        }));
        return { ids, complete: false, calls };
      }
      body = await res.json();
    } catch (err) {
      // 网络失败 / 响应体不是合法 JSON：吞掉异常，把已收集的 ids 和 complete:false
      // 一起还给调用方 —— 抛出异常会让调用方（Task 4 的 poller）既拿不到部分结果，
      // 也来不及记录本轮的轮询状态。
      console.error(JSON.stringify({
        event: "youtube_subscriptions_walk_exception",
        message: err instanceof Error ? err.message : String(err), collected: ids.length,
      }));
      return { ids, complete: false, calls };
    }

    // 200 但 items 不是数组：响应体畸形，不能当成「这一页没有订阅」。真正的空页
    // （items: [] 且没有 nextPageToken）必须仍然 complete:true，二者不能混淆。
    if (!Array.isArray(body.items)) {
      console.error(JSON.stringify({
        event: "youtube_subscriptions_walk_malformed_body",
        collected: ids.length,
      }));
      return { ids, complete: false, calls };
    }

    for (const item of body.items) {
      const channelId = item.snippet?.resourceId?.channelId;
      if (channelId) ids.push(channelId);
    }
    pageToken = body.nextPageToken;
  } while (pageToken);

  return { ids, complete: true, calls };
}

// 一批（≤50）频道的 snippet + statistics。失败直接抛，由调用方决定是跳过这一批
// 还是中止整轮 —— 这里没有足够上下文做那个决定。
export async function fetchChannelDetails(
  accessToken: string,
  channelIds: string[]
): Promise<YouTubeChannelItem[]> {
  if (channelIds.length === 0) return [];
  if (channelIds.length > CHANNELS_BATCH_SIZE) {
    throw new Error(`fetchChannelDetails: at most ${CHANNELS_BATCH_SIZE} ids per call, got ${channelIds.length}`);
  }

  const apiUrl = new URL(`${DATA_API_BASE}/channels`);
  apiUrl.searchParams.set("part", "snippet,statistics");
  apiUrl.searchParams.set("id", channelIds.join(","));
  apiUrl.searchParams.set("maxResults", String(CHANNELS_BATCH_SIZE));

  const res = await fetch(apiUrl.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new Error(`YouTube channels.list failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as { items?: YouTubeChannelItem[] };
  return body.items || [];
}
