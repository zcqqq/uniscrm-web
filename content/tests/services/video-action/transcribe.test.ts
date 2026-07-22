import { describe, it, expect, vi } from "vitest";
import { transcribeAudio, parseVtt, mergeCuesIntoSentences } from "../../../src/services/video-action/transcribe";

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

// Whisper returns WORD-level cues ("我们的" / "愿景" / "是"), which produced one-word-at-a-time
// subtitles on screen AND — more damagingly — sent each word to the translator with no
// surrounding context. Merging into sentences before translation fixes both at once.
describe("mergeCuesIntoSentences", () => {
  const words = (...pairs: [string, string, string][]) =>
    pairs.map(([start, end, text]) => ({ start, end, text }));

  it("merges consecutive word cues up to a sentence-ending punctuation mark", () => {
    const merged = mergeCuesIntoSentences(words(
      ["00:00:01.000", "00:00:01.400", "Our"],
      ["00:00:01.400", "00:00:01.900", "vision"],
      ["00:00:01.900", "00:00:02.600", "is simple."],
      ["00:00:02.600", "00:00:03.000", "Next"],
      ["00:00:03.000", "00:00:03.500", "one."],
    ));
    expect(merged).toEqual([
      { start: "00:00:01.000", end: "00:00:02.600", text: "Our vision is simple." },
      { start: "00:00:02.600", end: "00:00:03.500", text: "Next one." },
    ]);
  });

  it("spans the merged cue from the first start to the last end", () => {
    const merged = mergeCuesIntoSentences(words(
      ["00:00:04.240", "00:00:04.800", "a"],
      ["00:00:04.800", "00:00:05.040", "b."],
    ));
    expect(merged[0].start).toBe("00:00:04.240");
    expect(merged[0].end).toBe("00:00:05.040");
  });

  it("flushes on a character budget so a run-on sentence never becomes one giant subtitle", () => {
    const long = words(...Array.from({ length: 12 }, (_, i) =>
      [`00:00:${String(i).padStart(2, "0")}.000`, `00:00:${String(i + 1).padStart(2, "0")}.000`, "wordy"] as [string, string, string]
    ));
    const merged = mergeCuesIntoSentences(long, 20, 600);
    expect(merged.length).toBeGreaterThan(1);
    for (const cue of merged) expect(cue.text.length).toBeLessThanOrEqual(20);
  });

  it("flushes on a duration budget so a slow sentence never lingers too long", () => {
    const merged = mergeCuesIntoSentences(words(
      ["00:00:00.000", "00:00:05.000", "slow"],
      ["00:00:05.000", "00:00:10.000", "words"],
      ["00:00:10.000", "00:00:15.000", "here"],
    ), 500, 6);
    expect(merged.length).toBeGreaterThan(1);
  });

  it("handles CJK sentence-ending punctuation", () => {
    const merged = mergeCuesIntoSentences(words(
      ["00:00:00.000", "00:00:00.500", "这是"],
      ["00:00:00.500", "00:00:01.000", "测试。"],
      ["00:00:01.000", "00:00:01.500", "下一句"],
    ));
    expect(merged[0].text).toBe("这是 测试。");
    expect(merged).toHaveLength(2);
  });

  it("emits a trailing fragment that never reaches punctuation", () => {
    const merged = mergeCuesIntoSentences(words(
      ["00:00:00.000", "00:00:00.500", "no"],
      ["00:00:00.500", "00:00:01.000", "period here"],
    ));
    expect(merged).toEqual([{ start: "00:00:00.000", end: "00:00:01.000", text: "no period here" }]);
  });

  it("returns an empty list unchanged", () => {
    expect(mergeCuesIntoSentences([])).toEqual([]);
  });
});
