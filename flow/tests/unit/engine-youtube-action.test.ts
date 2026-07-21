import { describe, it, expect } from "vitest";
import { buildActionData } from "../../src/engine";

function node(data: Record<string, unknown>) {
  return { id: "a", type: "action", data } as any;
}

describe("buildActionData youtubeContentAction", () => {
  it("maps save-to-playlist with playlistId and success/failed branches", () => {
    const r = buildActionData(node({ actionType: "youtubeContentAction", operation: "save-to-playlist", playlistId: "pl1" }));
    expect(r).toMatchObject({ type: "youtubeContentAction", operation: "save-to-playlist", playlistId: "pl1", hasBranches: true });
  });

  it("defaults operation to save-to-playlist", () => {
    const r = buildActionData(node({ actionType: "youtubeContentAction" }));
    expect(r.operation).toBe("save-to-playlist");
  });
});
