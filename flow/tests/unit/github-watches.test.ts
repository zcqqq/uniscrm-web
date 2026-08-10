import { describe, it, expect } from "vitest";
import app from "../../src/index";

function env(graphs: string[]) {
  return {
    INTERNAL_SECRET: "s",
    FLOW_DB: {
      prepare: () => ({ all: async () => ({ results: graphs.map((g) => ({ graph_json: g })) }) }),
    },
  } as never;
}

async function watches(graphs: string[]) {
  const res = await app.fetch(
    new Request("http://f/internal/github-watches", { headers: { "X-Internal-Secret": "s" } }),
    env(graphs)
  );
  return ((await res.json()) as { watches: { channelId: string; fullName: string }[] }).watches;
}

const g = (channelId: string, repos: string[]) =>
  JSON.stringify({ nodes: [{ type: "githubContentTrigger", data: { channelId, repos: repos.map((fullName) => ({ fullName })) } }], edges: [] });

describe("GET /internal/github-watches", () => {
  it("拒绝没带 internal secret 的请求", async () => {
    const res = await app.fetch(new Request("http://f/internal/github-watches"), env([]));
    expect(res.status).toBe(401);
  });

  it("展开多选并按 (channel, repo) 去重", () => {
    return expect(watches([g("c1", ["a/x", "b/y"]), g("c1", ["a/x"]), g("c2", ["a/x"])])).resolves.toEqual([
      { channelId: "c1", fullName: "a/x" },
      { channelId: "c1", fullName: "b/y" },
      { channelId: "c2", fullName: "a/x" },
    ]);
  });

  it("跳过畸形 graph 而不是整条端点报错", async () => {
    expect(await watches(["not json", JSON.stringify({}), g("c1", ["a/x"])])).toEqual([{ channelId: "c1", fullName: "a/x" }]);
  });

  it("channelId 或 repos 为空的节点被忽略", async () => {
    expect(await watches([g("", ["a/x"]), g("c1", [])])).toEqual([]);
  });
});
