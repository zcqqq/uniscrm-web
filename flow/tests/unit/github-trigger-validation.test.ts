import { describe, it, expect } from "vitest";
import { validateFlowGraph, findGitHubTriggerNoRepoIds } from "../../frontend/lib/validate-flow-graph";
import { findBrokenTrigger } from "../../src/trigger-health";

// 一个最小的「trigger → action」图，data 由用例给。
const graph = (data: Record<string, unknown>) => ({
  nodes: [
    { id: "t1", type: "githubContentTrigger", data },
    { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "create-post", prompt: "p" } },
  ],
  edges: [{ source: "t1", target: "a1" }],
});

describe("findGitHubTriggerNoRepoIds", () => {
  it("一个 repo 都没选 = 永远不触发，必须在发布前拦住（静默发布是陷阱）", () => {
    expect(findGitHubTriggerNoRepoIds([{ id: "t1", type: "githubContentTrigger", data: { channelId: "c1", repos: [] } }]))
      .toEqual(["t1"]);
  });

  it("选了至少一个 repo 就放行", () => {
    expect(
      findGitHubTriggerNoRepoIds([
        { id: "t1", type: "githubContentTrigger", data: { channelId: "c1", repos: [{ fullName: "oven-sh/bun" }] } },
      ])
    ).toEqual([]);
  });

  it("走的是与运行时同一个 resolver：畸形 repos（AI 生成 / 手改）也算没选", () => {
    // 运行时 resolveGitHubRepos 会把这些全部过滤成 []，engine 永远匹配不上，
    // 所以发布校验必须给出同样的结论，否则「发布得了但不触发」。
    expect(findGitHubTriggerNoRepoIds([{ id: "t1", type: "githubContentTrigger", data: { repos: "oven-sh/bun" } }])).toEqual(["t1"]);
    expect(findGitHubTriggerNoRepoIds([{ id: "t1", type: "githubContentTrigger", data: { repos: [{ fullName: "" }] } }])).toEqual(["t1"]);
    expect(findGitHubTriggerNoRepoIds([{ id: "t1", type: "githubContentTrigger", data: {} }])).toEqual(["t1"]);
  });

  it("不碰别的 trigger 类型", () => {
    expect(findGitHubTriggerNoRepoIds([{ id: "t1", type: "youtubeContentTrigger", data: { subscriptions: [] } }])).toEqual([]);
  });
});

describe("validateFlowGraph 里的 githubContentTrigger", () => {
  it("没选 repo 时整图不合法，并把 trigger 节点 id 报出来给画布标红", () => {
    const { nodes, edges } = graph({ channelId: "c1", repos: [] });
    const result = validateFlowGraph(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.githubNoRepoNodeIds).toEqual(["t1"]);
  });

  it("账号 + 至少一个 repo 就通过", () => {
    const { nodes, edges } = graph({ channelId: "c1", repos: [{ fullName: "oven-sh/bun" }], includePrerelease: true });
    const result = validateFlowGraph(nodes, edges);
    expect(result.valid).toBe(true);
    expect(result.githubNoRepoNodeIds).toEqual([]);
  });
});

// channelId 为空这一条不在前端图校验里重复实现：publish 路径上 findBrokenTrigger 已经
// 用「channel 是否在 link 的 active 集合里」这条更强的判据拒绝它（空 channelId 必然不在集合中），
// 且那条判据还能识别"选过但账号后来断了"。这里把这个分工钉住，防止有人日后误以为没人管。
describe("channelId 为空由 publish 的 trigger-health 拦截", () => {
  it("repos 选好了但没有账号，publish 仍被拒", () => {
    const graphJson = JSON.stringify(graph({ channelId: "", repos: [{ fullName: "oven-sh/bun" }] }));
    expect(findBrokenTrigger(graphJson, new Set(["some-other-channel"]))).toEqual({
      nodeId: "t1",
      nodeType: "githubContentTrigger",
    });
  });

  it("账号已连接则不拦", () => {
    const graphJson = JSON.stringify(graph({ channelId: "gh-1", repos: [{ fullName: "oven-sh/bun" }] }));
    expect(findBrokenTrigger(graphJson, new Set(["gh-1"]))).toBeNull();
  });
});
