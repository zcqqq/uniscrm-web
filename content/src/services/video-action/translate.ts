import type { Env } from "../../types";
import { generateContent } from "../generate";
import type { Cue } from "./transcribe";

// WebVTT (what Whisper returns) makes the hours component OPTIONAL and omits it for every
// sub-hour video, so cues routinely arrive as "00:04.240". SRT requires the full
// "HH:MM:SS,mmm" form — ffmpeg's subtitles filter probes the file via avformat_open_input(),
// which rejects an hours-less timestamp and reports it as the misleading "Unable to open
// subs.srt" (the file is present and readable; it's a format-probe failure, not an I/O one).
function vttTimestampToSrt(timestamp: string): string {
  const [clock, fraction = ""] = timestamp.trim().split(".");
  const parts = clock.split(":");
  while (parts.length < 3) parts.unshift("0");
  const [hours, minutes, seconds] = parts.map((p) => p.padStart(2, "0"));
  const millis = fraction.padEnd(3, "0").slice(0, 3);
  return `${hours}:${minutes}:${seconds},${millis}`;
}

// The container builds the ASS subtitle file itself (it knows the frame geometry), so cues
// cross the boundary as plain millisecond offsets rather than any timestamp string format.
export function vttTimestampToMs(timestamp: string): number {
  const [clock, fraction = ""] = timestamp.trim().split(".");
  const parts = clock.split(":");
  while (parts.length < 3) parts.unshift("0");
  const [hours, minutes, seconds] = parts.map((p) => parseInt(p, 10) || 0);
  const millis = parseInt(fraction.padEnd(3, "0").slice(0, 3), 10) || 0;
  return (hours * 3600 + minutes * 60 + seconds) * 1000 + millis;
}

export function cuesToSrt(cues: Cue[]): string {
  return cues
    .map((cue, i) => `${i + 1}\n${vttTimestampToSrt(cue.start)} --> ${vttTimestampToSrt(cue.end)}\n${cue.text}`)
    .join("\n\n");
}

// One numbered-list call per CHUNK of lines, not one call for the whole video. Reproduced
// live: past ~40 lines the model degenerates — merges lines, renumbers, repeats whole blocks —
// so either the tail parses as missing (cues silently fall back to English) or, worse, numbers
// stay complete but carry the WRONG line's translation. Short chunks keep it on rails, and a
// chunk that still goes wrong only costs those few cues, not half the video.
const TRANSLATE_CHUNK_SIZE = 10;

// Translates one chunk of plain strings; per item, the translation or null (dropped line /
// failed call). Numbering restarts at 1 for every chunk — small numbers, small outputs.
async function translateChunk(
  env: Env,
  tenantId: number,
  texts: string[],
  targetLanguage: string
): Promise<(string | null)[]> {
  const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const prompt = `Translate each numbered line into ${targetLanguage}. Output ONLY the translated lines, same numbering, one per line, no commentary:\n\n${numbered}`;

  let response: string;
  try {
    response = await generateContent(env, { tenantId, prompt, provider: "default" });
  } catch (err) {
    console.error(JSON.stringify({ event: "translate_chunk_failed", chunkSize: texts.length, error: String(err) }));
    return texts.map(() => null);
  }

  // Match by the model's own leading number ("4. ...") rather than raw line position — the
  // model occasionally merges or drops a line, which must not shift every line after it.
  const byNumber = new Map<number, string>();
  for (const rawLine of response.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\.\s*(.*)$/);
    if (!match) continue;
    const text = match[2].trim();
    if (!text) continue;
    byNumber.set(parseInt(match[1], 10), text);
  }

  return texts.map((_, i) => byNumber.get(i + 1) ?? null);
}

export async function translateCues(
  env: Env,
  tenantId: number,
  cues: Cue[],
  targetLanguage: string,
  title = ""
): Promise<{ translatedCues: Cue[]; plainText: string; translatedTitle: string } | null> {
  // The title (overlaid at the top of the video) is just one more item in the list, riding
  // whichever chunk it lands in. It falls back to its original text like any dropped line.
  const items = cues.map((c) => c.text);
  if (title) items.push(title);

  const translated: (string | null)[] = [];
  for (let i = 0; i < items.length; i += TRANSLATE_CHUNK_SIZE) {
    translated.push(...await translateChunk(env, tenantId, items.slice(i, i + TRANSLATE_CHUNK_SIZE), targetLanguage));
  }

  if (translated.every((t) => t === null)) {
    console.error(JSON.stringify({ event: "translate_no_numbered_lines_parsed", cueCount: cues.length }));
    return null;
  }

  const missing: number[] = [];
  const translatedCues = cues.map((cue, i) => {
    const text = translated[i];
    if (text === null) {
      missing.push(i + 1);
      return { ...cue };
    }
    return { ...cue, text };
  });

  if (missing.length > 0) {
    console.error(JSON.stringify({ event: "translate_cue_fallback_to_original", missingCueNumbers: missing, totalCues: cues.length }));
  }

  const plainText = translatedCues.map((c) => c.text).join(" ");
  const translatedTitle = title ? (translated[items.length - 1] ?? title) : "";
  return { translatedCues, plainText, translatedTitle };
}
