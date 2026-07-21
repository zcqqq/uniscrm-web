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

export function cuesToSrt(cues: Cue[]): string {
  return cues
    .map((cue, i) => `${i + 1}\n${vttTimestampToSrt(cue.start)} --> ${vttTimestampToSrt(cue.end)}\n${cue.text}`)
    .join("\n\n");
}

export async function translateCues(
  env: Env,
  tenantId: number,
  cues: Cue[],
  targetLanguage: string
): Promise<{ translatedCues: Cue[]; plainText: string } | null> {
  const numbered = cues.map((cue, i) => `${i + 1}. ${cue.text}`).join("\n");
  const prompt = `Translate each numbered line into ${targetLanguage}. Output ONLY the translated lines, same numbering, one per line, no commentary:\n\n${numbered}`;

  let response: string;
  try {
    response = await generateContent(env, { tenantId, prompt, provider: "default" });
  } catch (err) {
    console.error(JSON.stringify({ event: "translate_failed", error: String(err) }));
    return null;
  }

  // Match by the model's own leading number ("14. ...") rather than raw line position — on a
  // long numbered batch the model occasionally merges or drops one line, which used to fail
  // the entire batch even though every other cue translated correctly. Any cue whose number
  // never shows up in the response falls back to its own original (untranslated) text instead.
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

  if (byNumber.size === 0) {
    console.error(JSON.stringify({ event: "translate_no_numbered_lines_parsed", cueCount: cues.length }));
    return null;
  }

  const missing: number[] = [];
  const translatedCues = cues.map((cue, i) => {
    const cueNumber = i + 1;
    const translated = byNumber.get(cueNumber);
    if (translated === undefined) {
      missing.push(cueNumber);
      return { ...cue };
    }
    return { ...cue, text: translated };
  });

  if (missing.length > 0) {
    console.error(JSON.stringify({ event: "translate_cue_fallback_to_original", missingCueNumbers: missing, totalCues: cues.length }));
  }

  const plainText = translatedCues.map((c) => c.text).join(" ");
  return { translatedCues, plainText };
}
