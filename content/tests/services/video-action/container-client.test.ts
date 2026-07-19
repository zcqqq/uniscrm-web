import { describe, it, expect, vi } from "vitest";
import { downloadAndExtract, burnSubtitles } from "../../../src/services/video-action/container-client";

function makeEnv(fetchResponse: unknown) {
  const container = {
    startAndWaitForPorts: vi.fn(async () => {}),
    fetch: vi.fn(async () => new Response(JSON.stringify(fetchResponse))),
  };
  return {
    SUBTITLE_CONTAINER: { getByName: () => container },
  } as any;
}

describe("container-client", () => {
  it("downloadAndExtract returns keys on success", async () => {
    const env = makeEnv({ video_key: "v1", audio_key: "a1" });
    const result = await downloadAndExtract(env, "job1", "https://youtube.com/watch?v=x");
    expect(result).toEqual({ videoKey: "v1", audioKey: "a1" });
  });

  it("downloadAndExtract surfaces an error", async () => {
    const env = makeEnv({ error: "download failed" });
    const result = await downloadAndExtract(env, "job1", "https://youtube.com/watch?v=x");
    expect(result.error).toBe("download failed");
  });

  it("burnSubtitles returns finalKey on success", async () => {
    const env = makeEnv({ final_key: "final-abc.mp4" });
    const result = await burnSubtitles(env, "job1", "video-action-jobs/job1/source.mp4", "1\n00:00:00,000 --> 00:00:01,000\nhello\n");
    expect(result).toEqual({ finalKey: "final-abc.mp4" });
  });
});
