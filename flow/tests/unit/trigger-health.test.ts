import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchActiveChannelIds, triggerBindsChannel, findBrokenTrigger, brokenTriggerMessage } from "../../src/trigger-health";

function graph(nodes: { id: string; type: string; data?: Record<string, unknown> }[]) {
  return JSON.stringify({
    nodes: nodes.map((n) => ({ ...n, data: n.data || {}, position: { x: 0, y: 0 } })),
    edges: [],
  });
}

describe("findBrokenTrigger", () => {
  const live = new Set(["chan-live"]);

  it("flags a trigger whose channel is no longer in the active set", () => {
    const g = graph([{ id: "t1", type: "xTrigger", data: { channelId: "chan-gone" } }]);
    expect(findBrokenTrigger(g, live)).toEqual({ nodeId: "t1", nodeType: "xTrigger" });
  });

  it("flags a trigger that was published without ever picking a channel", () => {
    const g = graph([{ id: "t1", type: "xTrigger", data: { channelId: "" } }]);
    expect(findBrokenTrigger(g, live)).toEqual({ nodeId: "t1", nodeType: "xTrigger" });
  });

  it("flags a trigger whose data has no channelId key at all", () => {
    const g = graph([{ id: "t1", type: "xContentTrigger" }]);
    expect(findBrokenTrigger(g, live)).toEqual({ nodeId: "t1", nodeType: "xContentTrigger" });
  });

  it("passes a trigger whose channel is still active", () => {
    const g = graph([{ id: "t1", type: "youtubeContentTrigger", data: { channelId: "chan-live" } }]);
    expect(findBrokenTrigger(g, live)).toBeNull();
  });

  it("never flags cronTrigger — it binds no channel", () => {
    const g = graph([{ id: "t1", type: "cronTrigger", data: { scheduleType: "daily" } }]);
    expect(findBrokenTrigger(g, live)).toBeNull();
  });

  it("ignores an action node's channelId — only the trigger is in scope", () => {
    const g = graph([
      { id: "t1", type: "xTrigger", data: { channelId: "chan-live" } },
      { id: "a1", type: "action", data: { actionType: "xAction", channelId: "chan-gone" } },
    ]);
    expect(findBrokenTrigger(g, live)).toBeNull();
  });

  it("passes a graph with no trigger node", () => {
    const g = graph([{ id: "a1", type: "action", data: { actionType: "xAction" } }]);
    expect(findBrokenTrigger(g, live)).toBeNull();
  });

  it("returns null when the active set is unknown (link unreachable)", () => {
    const g = graph([{ id: "t1", type: "xTrigger", data: { channelId: "chan-gone" } }]);
    expect(findBrokenTrigger(g, null)).toBeNull();
  });

  it("returns null on unparseable graph_json rather than throwing", () => {
    expect(findBrokenTrigger("{not json", live)).toBeNull();
    expect(findBrokenTrigger("", live)).toBeNull();
  });
});

describe("triggerBindsChannel", () => {
  it("is true for a channel-bound trigger", () => {
    expect(triggerBindsChannel(graph([{ id: "t1", type: "xTrigger", data: { channelId: "c" } }]))).toBe(true);
  });

  it("is true even when the channel was never picked — an empty channelId still needs checking", () => {
    expect(triggerBindsChannel(graph([{ id: "t1", type: "xTrigger" }]))).toBe(true);
  });

  it("is false for cronTrigger, so publishing one never depends on link being up", () => {
    expect(triggerBindsChannel(graph([{ id: "t1", type: "cronTrigger" }]))).toBe(false);
  });

  it("is false for a graph with no trigger, and for unparseable json", () => {
    expect(triggerBindsChannel(graph([{ id: "a1", type: "action" }]))).toBe(false);
    expect(triggerBindsChannel("{not json")).toBe(false);
  });
});

describe("fetchActiveChannelIds", () => {
  const env = { LINK_URL: "https://link.test", INTERNAL_SECRET: "s3cret" };

  afterEach(() => vi.unstubAllGlobals());

  it("returns the id set and sends the internal secret", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ channelIds: ["a", "b"] }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const ids = await fetchActiveChannelIds(env, 7);
    expect(ids).toEqual(new Set(["a", "b"]));
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://link.test/internal/channels/active?tenantId=7");
    expect((init.headers as Record<string, string>)["X-Internal-Secret"]).toBe("s3cret");
  });

  it("distinguishes an empty tenant from an unreachable link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ channelIds: [] }), { status: 200 })));
    expect(await fetchActiveChannelIds(env, 7)).toEqual(new Set());
  });

  it("returns null on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    expect(await fetchActiveChannelIds(env, 7)).toBeNull();
  });

  it("returns null when link throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await fetchActiveChannelIds(env, 7)).toBeNull();
  });

  it("returns null when the body is 200 but malformed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ oops: true }), { status: 200 })));
    expect(await fetchActiveChannelIds(env, 7)).toBeNull();
  });
});

describe("brokenTriggerMessage", () => {
  it("names X for both X trigger types", () => {
    expect(brokenTriggerMessage("xTrigger")).toContain("X account");
    expect(brokenTriggerMessage("xContentTrigger")).toContain("X account");
  });

  it("names YouTube for the YouTube trigger", () => {
    expect(brokenTriggerMessage("youtubeContentTrigger")).toContain("YouTube account");
  });

  it("falls back to a neutral noun for an unknown trigger type", () => {
    expect(brokenTriggerMessage("somethingNew")).toContain("channel");
  });
});
