import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchSubscribedChannelIds, fetchChannelDetails, CHANNELS_BATCH_SIZE } from "../../src/services/youtube-subscriptions-api";

function subsPage(ids: string[], nextPageToken?: string) {
  return new Response(JSON.stringify({
    items: ids.map((id) => ({ snippet: { resourceId: { channelId: id }, title: `t-${id}` } })),
    nextPageToken,
  }), { status: 200 });
}

describe("fetchSubscribedChannelIds", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it("翻完所有页，complete = true", async () => {
    fetchMock
      .mockResolvedValueOnce(subsPage(["UC1", "UC2"], "p2"))
      .mockResolvedValueOnce(subsPage(["UC3"]));

    const r = await fetchSubscribedChannelIds("tok", Date.now() + 60_000);

    expect(r.ids).toEqual(["UC1", "UC2", "UC3"]);
    expect(r.complete).toBe(true);
    expect(r.calls).toBe(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("mine=true");
    expect(String(fetchMock.mock.calls[1][0])).toContain("pageToken=p2");
  });

  // 半份列表绝不能被当成完整列表 —— 下游据此跳过 diff，否则仍在订阅的频道会被误置 is_follow=0。
  it("中途某页失败时 complete = false，但已拿到的 id 照常返回", async () => {
    fetchMock
      .mockResolvedValueOnce(subsPage(["UC1"], "p2"))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));

    const r = await fetchSubscribedChannelIds("tok", Date.now() + 60_000);

    expect(r.ids).toEqual(["UC1"]);
    expect(r.complete).toBe(false);
  });

  it("撞 deadline 时 complete = false", async () => {
    fetchMock.mockResolvedValue(subsPage(["UC1"], "p2"));

    const r = await fetchSubscribedChannelIds("tok", Date.now() - 1);

    expect(r.complete).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("跳过没有 resourceId.channelId 的条目", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      items: [{ snippet: { title: "broken" } }, { snippet: { resourceId: { channelId: "UC9" } } }],
    }), { status: 200 }));

    const r = await fetchSubscribedChannelIds("tok", Date.now() + 60_000);
    expect(r.ids).toEqual(["UC9"]);
  });
});

describe("fetchChannelDetails", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it("一次请求带上全部 id，并要 snippet + statistics", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      items: [{ id: "UC1", snippet: { title: "A" }, statistics: { subscriberCount: "10" } }],
    }), { status: 200 }));

    const items = await fetchChannelDetails("tok", ["UC1", "UC2"]);

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("id=UC1%2CUC2");
    expect(url).toContain("part=snippet%2Cstatistics");
    expect(items).toHaveLength(1);
    expect(items[0].statistics?.subscriberCount).toBe("10");
  });

  it("超过 50 个 id 直接抛错 —— 分批是调用方的责任", async () => {
    const ids = Array.from({ length: CHANNELS_BATCH_SIZE + 1 }, (_, i) => `UC${i}`);
    await expect(fetchChannelDetails("tok", ids)).rejects.toThrow(/50/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("非 2xx 抛错，错误信息带状态码", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 403 }));
    await expect(fetchChannelDetails("tok", ["UC1"])).rejects.toThrow(/403/);
  });

  it("空数组不发请求", async () => {
    expect(await fetchChannelDetails("tok", [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
