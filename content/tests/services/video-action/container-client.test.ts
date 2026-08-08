import { describe, it, expect, vi } from "vitest";
import { downloadAndExtract, burnSubtitles, downloadVideo, rotateToVertical, removeFace, probeDimensions } from "../../../src/services/video-action/container-client";

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

  it("burnSubtitles sends structured cues plus title and returns finalKey on success", async () => {
    const env = makeEnv({ final_key: "final-abc.mp4" });
    const cues = [{ start_ms: 0, end_ms: 1000, text: "你好" }];
    const result = await burnSubtitles(env, "job1", "video-action-jobs/job1/source.mp4", cues, "标题");
    expect(result).toEqual({ finalKey: "final-abc.mp4" });
    const container = env.SUBTITLE_CONTAINER.getByName("subtitle-singleton");
    const sent = JSON.parse(container.fetch.mock.calls[0][1].body);
    expect(sent.cues).toEqual(cues);
    expect(sent.title_text).toBe("标题");
    expect(sent.subtitle_srt).toBeUndefined();
  });

  it("downloadVideo returns videoKey on success", async () => {
    const env = makeEnv({ video_key: "v2" });
    const result = await downloadVideo(env, "job1", "https://youtube.com/watch?v=x");
    expect(result).toEqual({ videoKey: "v2" });
  });

  it("downloadVideo surfaces an error", async () => {
    const env = makeEnv({ error: "download failed" });
    const result = await downloadVideo(env, "job1", "https://youtube.com/watch?v=x");
    expect(result.error).toBe("download failed");
  });

  it("rotateToVertical returns finalKey on success", async () => {
    const env = makeEnv({ final_key: "rotated-abc.mp4" });
    const result = await rotateToVertical(env, "job1", "video-action-jobs/job1/source.mp4");
    expect(result).toEqual({ finalKey: "rotated-abc.mp4" });
  });

  it("rotateToVertical surfaces an error", async () => {
    const env = makeEnv({ error: "rotate failed" });
    const result = await rotateToVertical(env, "job1", "video-action-jobs/job1/source.mp4");
    expect(result.error).toBe("rotate failed");
  });

  it("removeFace returns finalKey on success", async () => {
    const env = makeEnv({ final_key: "trimmed-abc.mp4" });
    const result = await removeFace(env, "job1", "video-action-jobs/job1/source.mp4");
    expect(result).toEqual({ finalKey: "trimmed-abc.mp4" });
  });

  it("removeFace surfaces an error", async () => {
    const env = makeEnv({ error: "video too short after face removal" });
    const result = await removeFace(env, "job1", "video-action-jobs/job1/source.mp4");
    expect(result.error).toBe("video too short after face removal");
  });

  it("probeDimensions returns width/height/ratio on success", async () => {
    const env = makeEnv({ width: 1080, height: 1920, ratio: 0.5625 });
    const result = await probeDimensions(env, "job1", "video-action-jobs/job1/source.mp4");
    expect(result).toEqual({ width: 1080, height: 1920, ratio: 0.5625 });
  });

  it("probeDimensions surfaces an error", async () => {
    const env = makeEnv({ error: "dimension probe failed: ffprobe exited 1" });
    const result = await probeDimensions(env, "job1", "video-action-jobs/job1/source.mp4");
    expect(result.error).toBe("dimension probe failed: ffprobe exited 1");
  });
});
