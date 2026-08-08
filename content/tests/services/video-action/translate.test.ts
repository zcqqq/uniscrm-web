import { describe, it, expect, vi } from "vitest";
import { translateCues, cuesToSrt, vttTimestampToMs } from "../../../src/services/video-action/translate";
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

  it("translates the title as one extra numbered line in the same call", async () => {
    const spy = vi.spyOn(generateModule, "generateContent")
      .mockResolvedValue("1. 你好。\n2. 这是一个测试。\n3. 一个标题");
    const result = await translateCues({} as any, 1, cues, "zh", "A title");
    expect(spy.mock.lastCall?.[1].prompt).toContain("3. A title");
    expect(result?.translatedTitle).toBe("一个标题");
    expect(result?.translatedCues).toHaveLength(2);
    // The title line must not leak into the subtitle text.
    expect(result?.plainText).toBe("你好。 这是一个测试。");
  });

  it("falls back to the original title when its line is missing from the response", async () => {
    vi.spyOn(generateModule, "generateContent").mockResolvedValue("1. 你好。\n2. 这是一个测试。");
    const result = await translateCues({} as any, 1, cues, "zh", "A title");
    expect(result?.translatedTitle).toBe("A title");
  });

  it("returns an empty translatedTitle when no title is given", async () => {
    vi.spyOn(generateModule, "generateContent").mockResolvedValue("1. 你好。\n2. 这是一个测试。");
    const result = await translateCues({} as any, 1, cues, "zh");
    expect(result?.translatedTitle).toBe("");
  });

  // One giant numbered list makes the model degenerate past ~40 lines (merged/renumbered/
  // repeated output, observed live) — so the list is translated in chunks of 10, each
  // renumbered from 1, and a failed chunk only loses its own cues.
  it("splits long cue lists into chunks of 10 with per-chunk numbering", async () => {
    const manyCues: Cue[] = Array.from({ length: 12 }, (_, i) => ({
      start: `00:0${i}.000`, end: `00:0${i}.900`, text: `line ${i + 1}`,
    }));
    const spy = vi.spyOn(generateModule, "generateContent").mockImplementation(async (_env, params) => {
      const count = (params.prompt.match(/^\d+\./gm) || []).length;
      return Array.from({ length: count }, (_, i) => `${i + 1}. 中文${i + 1}`).join("\n");
    });
    spy.mockClear();

    const result = await translateCues({} as any, 1, manyCues, "zh", "A title");

    // 12 cues + title = 13 items -> chunk of 10 + chunk of 3
    const chunkSpy = spy.mock.calls.filter((c) => c[1].prompt.includes("Translate each numbered line"));
    expect(chunkSpy).toHaveLength(2);
    expect((chunkSpy[0][1].prompt.match(/^\d+\./gm) || [])).toHaveLength(10);
    expect((chunkSpy[1][1].prompt.match(/^\d+\./gm) || [])).toHaveLength(3);
    // second chunk restarts numbering at 1
    expect(chunkSpy[1][1].prompt).toContain("1. line 11");
    expect(chunkSpy[1][1].prompt).toContain("3. A title");
    // items map back positionally: cue 11 takes the second chunk's first line
    expect(result?.translatedCues[10].text).toBe("中文1");
    expect(result?.translatedTitle).toBe("中文3");
  });

  it("a failed chunk only drops its own cues to原文, other chunks still translate", async () => {
    const manyCues: Cue[] = Array.from({ length: 12 }, (_, i) => ({
      start: `00:0${i}.000`, end: `00:0${i}.900`, text: `line ${i + 1}`,
    }));
    let call = 0;
    vi.spyOn(generateModule, "generateContent").mockImplementation(async (_env, params) => {
      call += 1;
      if (call === 1) throw new Error("model error");
      const count = (params.prompt.match(/^\d+\./gm) || []).length;
      return Array.from({ length: count }, (_, i) => `${i + 1}. 中文${i + 1}`).join("\n");
    });

    const result = await translateCues({} as any, 1, manyCues, "zh");
    expect(result?.translatedCues[0].text).toBe("line 1");
    expect(result?.translatedCues[9].text).toBe("line 10");
    expect(result?.translatedCues[10].text).toBe("中文1");
  });
});

describe("vttTimestampToMs", () => {
  it("converts full and short-form WebVTT timestamps to milliseconds", () => {
    expect(vttTimestampToMs("00:00:02.000")).toBe(2000);
    expect(vttTimestampToMs("00:04.240")).toBe(4240);
    expect(vttTimestampToMs("01:02:03.456")).toBe(3723456);
    expect(vttTimestampToMs("00:04")).toBe(4000);
  });
});
