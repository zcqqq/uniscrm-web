import type { Env } from "../../types";
import { generateContent } from "../generate";
import type { Cue } from "./transcribe";

export function cuesToSrt(cues: Cue[]): string {
  return cues
    .map((cue, i) => `${i + 1}\n${cue.start.replace(".", ",")} --> ${cue.end.replace(".", ",")}\n${cue.text}`)
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

  const lines = response
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^\d+\.\s*/, ""));

  if (lines.length !== cues.length) {
    console.error(JSON.stringify({ event: "translate_cue_count_mismatch", expected: cues.length, got: lines.length }));
    return null;
  }

  const translatedCues = cues.map((cue, i) => ({ ...cue, text: lines[i] }));
  const plainText = translatedCues.map((c) => c.text).join(" ");
  return { translatedCues, plainText };
}
