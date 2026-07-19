import { describe, it, expect, vi } from "vitest";
import { translateCues, cuesToSrt } from "../../../src/services/video-action/translate";
import * as generateModule from "../../../src/services/generate";
import type { Cue } from "../../../src/services/video-action/transcribe";

const cues: Cue[] = [
  { start: "00:00:00.000", end: "00:00:02.000", text: "Hello there." },
  { start: "00:00:02.000", end: "00:00:04.000", text: "This is a test." },
];

describe("cuesToSrt", () => {
  it("converts VTT-style timestamps to SRT format with sequential indices", () => {
    const srt = cuesToSrt(cues);
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:02,000\nHello there.");
    expect(srt).toContain("2\n00:00:02,000 --> 00:00:04,000\nThis is a test.");
  });
});

describe("translateCues", () => {
  it("translates all cues and preserves count/order", async () => {
    vi.spyOn(generateModule, "generateContent").mockResolvedValue("1. 你好。\n2. 这是一个测试。");
    const result = await translateCues({} as any, 1, cues, "zh");
    expect(result?.translatedCues).toEqual([
      { start: "00:00:00.000", end: "00:00:02.000", text: "你好。" },
      { start: "00:00:02.000", end: "00:00:04.000", text: "这是一个测试。" },
    ]);
    expect(result?.plainText).toBe("你好。 这是一个测试。");
  });

  it("returns null on a cue-count mismatch", async () => {
    vi.spyOn(generateModule, "generateContent").mockResolvedValue("1. 你好。");
    const result = await translateCues({} as any, 1, cues, "zh");
    expect(result).toBeNull();
  });

  it("returns null when generateContent throws", async () => {
    vi.spyOn(generateModule, "generateContent").mockRejectedValue(new Error("model error"));
    const result = await translateCues({} as any, 1, cues, "zh");
    expect(result).toBeNull();
  });
});
