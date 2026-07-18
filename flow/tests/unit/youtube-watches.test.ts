import { describe, it, expect, vi } from "vitest";
import worker from "../../src/index";

function makeEnv(flowRows: { graph_json: string }[]) {
  return {
    INTERNAL_SECRET: "secret",
    FLOW_DB: {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({ results: flowRows }),
      }),
    },
  } as any;
}

function req(path: string, headers: Record<string, string> = {}) {
  return new Request(`https://flow.test${path}`, { headers });
}

describe("GET /internal/youtube-watches", () => {
  it("rejects requests without the internal secret", async () => {
    const res = await worker.fetch(req("/internal/youtube-watches"), makeEnv([]));
    expect(res.status).toBe(401);
  });

  it("returns distinct channelIds from published youtubeContentTrigger nodes", async () => {
    const graph = {
      nodes: [
        { id: "n1", type: "youtubeContentTrigger", data: { channelId: "chanA" } },
        { id: "n2", type: "youtubeContentTrigger", data: { channelId: "chanA" } }, // dup, same flow
        { id: "n3", type: "xContentTrigger", data: { channelId: "chanX", mode: "get-list-posts", listId: "l1" } }, // ignored, wrong type
      ],
    };
    const env = makeEnv([{ graph_json: JSON.stringify(graph) }]);
    const res = await worker.fetch(req("/internal/youtube-watches", { "X-Internal-Secret": "secret" }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.watches).toEqual([{ channelId: "chanA" }]);
  });

  it("skips nodes with a blank channelId", async () => {
    const graph = { nodes: [{ id: "n1", type: "youtubeContentTrigger", data: { channelId: "" } }] };
    const env = makeEnv([{ graph_json: JSON.stringify(graph) }]);
    const res = await worker.fetch(req("/internal/youtube-watches", { "X-Internal-Secret": "secret" }), env);
    const body = await res.json() as any;
    expect(body.watches).toEqual([]);
  });
});
