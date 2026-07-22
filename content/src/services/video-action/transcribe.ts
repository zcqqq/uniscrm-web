import type { Env } from "../../types";

export interface Cue {
  start: string;
  end: string;
  text: string;
}

export function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = vtt.split(/\r?\n\r?\n/).map((b) => b.trim()).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;
    const [start, end] = timeLine.split("-->").map((s) => s.trim());
    const textLines = lines.slice(lines.indexOf(timeLine) + 1);
    const text = textLines.join(" ").trim();
    if (!text) continue;
    cues.push({ start, end, text });
  }
  return cues;
}

// Numeric parse for duration comparison only. Deliberately NOT shared with translate.ts's
// vttTimestampToSrt, which formats the exact string ffmpeg parses — routing that through a
// float would risk reintroducing the malformed-timestamp bug for a rounding-level gain.
function vttTimestampToSeconds(timestamp: string): number {
  const [clock, fraction = "0"] = timestamp.trim().split(".");
  const parts = clock.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [hours, minutes, seconds] = parts;
  return hours * 3600 + minutes * 60 + seconds + Number(`0.${fraction}`);
}

const SENTENCE_END = /[.!?。！？…]["'”’)\]]?$/;

// Whisper emits one cue per word. Left as-is that produces one-word-at-a-time subtitles, and
// (worse) sends every word to the translator on its own with no surrounding context. Merging
// into sentences here — before translation — fixes the on-screen result and the translation
// quality together, and collapses ~25 cues into a handful, which also shrinks the surface for
// the translator to drop a line.
// maxChars is measured on the pre-translation source text. ~32 source characters lands around
// 12-16 Chinese characters, which renders as at most two lines at 1080px wide — matching what
// the burn-in step reserves space for below the picture.
export function mergeCuesIntoSentences(cues: Cue[], maxChars = 32, maxSeconds = 6): Cue[] {
  const merged: Cue[] = [];
  let buffer: Cue | null = null;

  for (const cue of cues) {
    if (!buffer) {
      buffer = { ...cue };
    } else {
      const combined = `${buffer.text} ${cue.text}`.trim();
      const spansTooLong = vttTimestampToSeconds(cue.end) - vttTimestampToSeconds(buffer.start) > maxSeconds;
      if (combined.length > maxChars || spansTooLong) {
        merged.push(buffer);
        buffer = { ...cue };
      } else {
        buffer = { start: buffer.start, end: cue.end, text: combined };
      }
    }
    if (SENTENCE_END.test(buffer.text)) {
      merged.push(buffer);
      buffer = null;
    }
  }

  if (buffer) merged.push(buffer);
  return merged;
}

export async function transcribeAudio(env: Env, audioKey: string): Promise<Cue[] | null> {
  const object = await env.MEDIA_BUCKET.get(audioKey);
  if (!object) return null;

  try {
    const buffer = await object.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    const result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: base64 }) as { vtt?: string };
    if (!result.vtt) return null;
    const cues = mergeCuesIntoSentences(parseVtt(result.vtt));
    return cues.length > 0 ? cues : null;
  } catch (err) {
    console.error(JSON.stringify({ event: "transcribe_failed", audioKey, error: String(err) }));
    return null;
  }
}
