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

  it("falls back to the original text for a cue whose number never appears in the response", async () => {
    vi.spyOn(generateModule, "generateContent").mockResolvedValue("1. 你好。");
    const result = await translateCues({} as any, 1, cues, "zh");
    expect(result?.translatedCues).toEqual([
      { start: "00:00:00.000", end: "00:00:02.000", text: "你好。" },
      { start: "00:00:02.000", end: "00:00:04.000", text: "This is a test." },
    ]);
    expect(result?.plainText).toBe("你好。 This is a test.");
  });

  it("matches cues by their own leading number, not by line position", async () => {
    // Out-of-order response — line position would misalign these, number matching won't.
    vi.spyOn(generateModule, "generateContent").mockResolvedValue("2. 这是一个测试。\n1. 你好。");
    const result = await translateCues({} as any, 1, cues, "zh");
    expect(result?.translatedCues).toEqual([
      { start: "00:00:00.000", end: "00:00:02.000", text: "你好。" },
      { start: "00:00:02.000", end: "00:00:04.000", text: "这是一个测试。" },
    ]);
  });

  it("ignores a numbered line outside the cue range instead of letting it shift alignment", async () => {
    vi.spyOn(generateModule, "generateContent").mockResolvedValue("1. 你好。\n2. 这是一个测试。\n3. 多出来的一行。");
    const result = await translateCues({} as any, 1, cues, "zh");
    expect(result?.translatedCues).toEqual([
      { start: "00:00:00.000", end: "00:00:02.000", text: "你好。" },
      { start: "00:00:02.000", end: "00:00:04.000", text: "这是一个测试。" },
    ]);
  });

  it("returns null when no numbered line can be parsed from the response at all", async () => {
    vi.spyOn(generateModule, "generateContent").mockResolvedValue("I cannot translate this content.");
    const result = await translateCues({} as any, 1, cues, "zh");
    expect(result).toBeNull();
  });

  it("returns null when generateContent throws", async () => {
    vi.spyOn(generateModule, "generateContent").mockRejectedValue(new Error("model error"));
    const result = await translateCues({} as any, 1, cues, "zh");
    expect(result).toBeNull();
  });
});
