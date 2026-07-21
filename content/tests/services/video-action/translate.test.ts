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

  // Whisper emits WebVTT, where the hours component is OPTIONAL ("MM:SS.mmm") — and it omits
  // it for every sub-hour video. SRT requires the full "HH:MM:SS,mmm" form: ffmpeg's subtitles
  // filter probes the file with avformat_open_input(), which fails on an hours-less timestamp
  // and reports it as the misleading "Unable to open subs.srt". Reproduced in-container: the
  // same burn-in call succeeds with hours present and fails without, all else identical.
  it("pads hours onto WebVTT short-form timestamps, which SRT requires", () => {
    const srt = cuesToSrt([{ start: "00:04.240", end: "00:04.800", text: "我们的" }]);
    expect(srt).toBe("1\n00:00:04,240 --> 00:00:04,800\n我们的");
  });

  it("leaves already-full-form timestamps unchanged apart from the decimal separator", () => {
    const srt = cuesToSrt([{ start: "01:02:03.456", end: "01:02:04.789", text: "hi" }]);
    expect(srt).toBe("1\n01:02:03,456 --> 01:02:04,789\nhi");
  });

  it("zero-pads single-digit components and a short fraction", () => {
    const srt = cuesToSrt([{ start: "1:2.3", end: "9:8.75", text: "x" }]);
    expect(srt).toBe("1\n00:01:02,300 --> 00:09:08,750\nx");
  });

  it("supplies a zero fraction when the timestamp has none", () => {
    const srt = cuesToSrt([{ start: "00:04", end: "00:05", text: "x" }]);
    expect(srt).toBe("1\n00:00:04,000 --> 00:00:05,000\nx");
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
