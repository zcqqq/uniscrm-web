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

export async function transcribeAudio(env: Env, audioKey: string): Promise<Cue[] | null> {
  const object = await env.MEDIA_BUCKET.get(audioKey);
  if (!object) return null;

  try {
    const buffer = await object.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    const result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: base64 }) as { vtt?: string };
    if (!result.vtt) return null;
    const cues = parseVtt(result.vtt);
    return cues.length > 0 ? cues : null;
  } catch (err) {
    console.error(JSON.stringify({ event: "transcribe_failed", audioKey, error: String(err) }));
    return null;
  }
}
