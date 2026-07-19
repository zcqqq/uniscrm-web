import { describe, it, expect, vi } from "vitest";
import { transcribeAudio, parseVtt } from "../../../src/services/video-action/transcribe";

describe("parseVtt", () => {
  it("parses cues with timestamps and text", () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.500
Hello there.

00:00:02.500 --> 00:00:05.000
This is a test.
`;
    const cues = parseVtt(vtt);
    expect(cues).toEqual([
      { start: "00:00:00.000", end: "00:00:02.500", text: "Hello there." },
      { start: "00:00:02.500", end: "00:00:05.000", text: "This is a test." },
    ]);
  });
});

describe("transcribeAudio", () => {
  it("returns null when the audio object is missing from R2", async () => {
    const env = {
      MEDIA_BUCKET: { get: async () => null },
      AI: { run: vi.fn() },
    } as any;
    const result = await transcribeAudio(env, "video-action-jobs/job1/audio.mp3");
    expect(result).toBeNull();
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("returns parsed cues on a successful Whisper call", async () => {
    const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHi\n";
    const env = {
      MEDIA_BUCKET: { get: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) },
      AI: { run: vi.fn(async () => ({ vtt })) },
    } as any;
    const result = await transcribeAudio(env, "video-action-jobs/job1/audio.mp3");
    expect(result).toEqual([{ start: "00:00:00.000", end: "00:00:01.000", text: "Hi" }]);
  });

  it("returns null when Workers AI throws", async () => {
    const env = {
      MEDIA_BUCKET: { get: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) },
      AI: { run: vi.fn(async () => { throw new Error("model error"); }) },
    } as any;
    const result = await transcribeAudio(env, "video-action-jobs/job1/audio.mp3");
    expect(result).toBeNull();
  });
});
