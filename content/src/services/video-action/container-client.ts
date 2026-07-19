import type { Env } from "../../types";

export interface DownloadResult {
  videoKey?: string;
  audioKey?: string;
  error?: string;
}

export interface BurnResult {
  finalKey?: string;
  error?: string;
}

export async function downloadAndExtract(env: Env, jobId: string, videoUrl: string): Promise<DownloadResult> {
  const container = env.SUBTITLE_CONTAINER.getByName("subtitle-singleton");
  await container.startAndWaitForPorts();
  const res = await container.fetch("http://container/download-and-extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId, video_url: videoUrl }),
  });
  const body = await res.json() as { video_key?: string; audio_key?: string; error?: string };
  if (body.error) return { error: body.error };
  return { videoKey: body.video_key, audioKey: body.audio_key };
}

export async function burnSubtitles(env: Env, jobId: string, videoKey: string, subtitleSrt: string): Promise<BurnResult> {
  const container = env.SUBTITLE_CONTAINER.getByName("subtitle-singleton");
  await container.startAndWaitForPorts();
  const res = await container.fetch("http://container/burn-subtitles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId, video_key: videoKey, subtitle_srt: subtitleSrt }),
  });
  const body = await res.json() as { final_key?: string; error?: string };
  if (body.error) return { error: body.error };
  return { finalKey: body.final_key };
}
