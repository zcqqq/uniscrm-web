import { describe, it, expect } from "vitest";
// FlowGraph lives in src/engine.ts (src/types.ts holds the Env/queue-envelope shapes only).
import { executeFlow, type FlowGraph } from "../../src/engine";

const NOW = Date.parse("2026-08-10T00:00:00Z");

function graph(data: Record<string, unknown>, conditions: unknown[] = []): FlowGraph {
  return {
    nodes: [
      { id: "t1", type: "githubContentTrigger", data: { channelId: "chan-1", repos: [{ fullName: "oven-sh/bun" }], conditions, ...data } },
      { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "create-post" } },
    ],
    edges: [{ id: "e1", source: "t1", target: "a1" }],
  } as unknown as FlowGraph;
}

function payload(over: Record<string, unknown> = {}) {
  return {
    channel_id: "chan-1",
    repo_full_name: "oven-sh/bun",
    content_text: "notes",
    is_prerelease: 0,
    release_history: [
      { published_at: "2026-08-09T12:00:00Z", prerelease: false },
      { published_at: "2026-08-06T00:00:00Z", prerelease: true },
      { published_at: "2026-07-20T00:00:00Z", prerelease: false },
    ],
    ...over,
  };
}

describe("githubContentTrigger 匹配", () => {
  it("channel 与 repo 都对上才触发", () => {
    expect(executeFlow(graph({}), "content.created", payload(), NOW).matched).toBe(true);
    expect(executeFlow(graph({}), "content.created", payload({ channel_id: "other" }), NOW).matched).toBe(false);
    expect(executeFlow(graph({ repos: [{ fullName: "other/repo" }] }), "content.created", payload(), NOW).matched).toBe(false);
  });

  it("默认不触发预发布", () => {
    expect(executeFlow(graph({}), "content.created", payload({ is_prerelease: 1 }), NOW).matched).toBe(false);
  });

  it("勾了 includePrerelease 才触发预发布", () => {
    expect(executeFlow(graph({ includePrerelease: true }), "content.created", payload({ is_prerelease: 1 }), NOW).matched).toBe(true);
  });

  // fail-closed 回归：轮询器确实把 is_prerelease 归一成 0/1，但 POST /internal/trigger 接受
  // 任意 payload，布尔 true / 字符串 "1" 是真能到达匹配器的形状。用 !== 1 严格比会让它们
  // 从「不含预发布」的节点下面溜过去 —— 那意味着替用户公开发帖宣传一个 RC。
  it("布尔 true 与字符串 \"1\" 一样算预发布，默认不触发", () => {
    expect(executeFlow(graph({}), "content.created", payload({ is_prerelease: true }), NOW).matched).toBe(false);
    expect(executeFlow(graph({}), "content.created", payload({ is_prerelease: "1" }), NOW).matched).toBe(false);
  });

  it("布尔 false 与字符串 \"0\" 仍然算正式版，照常触发", () => {
    expect(executeFlow(graph({}), "content.created", payload({ is_prerelease: false }), NOW).matched).toBe(true);
    expect(executeFlow(graph({}), "content.created", payload({ is_prerelease: "0" }), NOW).matched).toBe(true);
  });

  it("事件类型不是 content.created 不触发", () => {
    expect(executeFlow(graph({}), "follow.follow", payload(), NOW).matched).toBe(false);
  });
});

describe("githubContentTrigger 的计数注入", () => {
  it("按节点口径注入三个计数并删掉 release_history", () => {
    const r = executeFlow(graph({}), "content.created", payload(), NOW);
    expect(r.payload.release_count_1d).toBe(1);
    expect(r.payload.release_count_7d).toBe(1);   // 8-06 那条是预发布，默认不数
    expect(r.payload.release_count_30d).toBe(2);
    expect(r.payload.release_history).toBeUndefined();
  });

  it("勾了 includePrerelease 时计数把预发布算进来", () => {
    const r = executeFlow(graph({ includePrerelease: true }), "content.created", payload(), NOW);
    expect(r.payload.release_count_7d).toBe(2);
    expect(r.payload.release_count_30d).toBe(3);
  });

  it("条件基于注入后的计数求值", () => {
    const pass = executeFlow(graph({}, [{ field: "release_count_30d", operator: ">=", value: "2" }]), "content.created", payload(), NOW);
    expect(pass.matched).toBe(true);
    const fail = executeFlow(graph({}, [{ field: "release_count_30d", operator: ">=", value: "5" }]), "content.created", payload(), NOW);
    expect(fail.matched).toBe(false);
  });

  it("其它 trigger 类型的 payload 逐字不变", () => {
    const g = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan-1", conditions: [] } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "repost-post" } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    } as unknown as FlowGraph;
    const p = { channel_id: "chan-1", content_text: "x" };
    expect(executeFlow(g, "content.created", p).payload).toEqual(p);
  });
});
