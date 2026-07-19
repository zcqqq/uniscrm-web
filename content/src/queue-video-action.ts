import type { Env } from "./types";
import { createJob, updateJobStatus } from "./services/video-action/job-store";
import { downloadAndExtract, burnSubtitles } from "./services/video-action/container-client";
import { transcribeAudio } from "./services/video-action/transcribe";
import { translateCues, cuesToSrt } from "./services/video-action/translate";

export interface VideoActionQueueMessage {
  pendingId: string;
  contentId: string;
  tenantId: number;
  videoUrl: string;
  targetLanguage: string;
  flowId: string;
  nodeId: string;
  payload: Record<string, unknown>;
}

async function resumeFlow(env: Env, pendingId: string, branch: "success" | "failed", props: Record<string, unknown> = {}): Promise<void> {
  try {
    await fetch(`${env.FLOW_URL}/internal/video-action/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
      body: JSON.stringify({ pendingId, branch, props }),
    });
  } catch (err) {
    console.error(JSON.stringify({ event: "video_action_resume_callback_failed", pendingId, error: String(err) }));
    // No retry — flow's content_flow_pending timeout sweep is the backstop for a dropped callback.
  }
}

async function cleanupScratch(env: Env, jobId: string): Promise<void> {
  try {
    await env.MEDIA_BUCKET.delete(`video-action-jobs/${jobId}/source.mp4`);
    await env.MEDIA_BUCKET.delete(`video-action-jobs/${jobId}/audio.mp3`);
  } catch (err) {
    console.error(JSON.stringify({ event: "video_action_scratch_cleanup_failed", jobId, error: String(err) }));
  }
}

export async function processVideoActionJob(env: Env, message: VideoActionQueueMessage): Promise<void> {
  let jobId: string;
  try {
    jobId = await createJob(env, {
      pendingId: message.pendingId, contentId: message.contentId,
      tenantId: message.tenantId, targetLanguage: message.targetLanguage,
    });
  } catch (err) {
    console.error(JSON.stringify({ event: "video_action_job_create_failed", pendingId: message.pendingId, error: String(err) }));
    await resumeFlow(env, message.pendingId, "failed");
    return;
  }

  try {
    const downloaded = await downloadAndExtract(env, jobId, message.videoUrl);
    if (downloaded.error || !downloaded.videoKey || !downloaded.audioKey) {
      await updateJobStatus(env, jobId, "failed", "downloading", downloaded.error || "unknown download error");
      await cleanupScratch(env, jobId);
      await resumeFlow(env, message.pendingId, "failed");
      return;
    }

    await updateJobStatus(env, jobId, "transcribing");
    const cues = await transcribeAudio(env, downloaded.audioKey);
    if (!cues) {
      await updateJobStatus(env, jobId, "failed", "transcribing", "no speech detected or transcription error");
      await cleanupScratch(env, jobId);
      await resumeFlow(env, message.pendingId, "failed");
      return;
    }

    await updateJobStatus(env, jobId, "translating");
    const translated = await translateCues(env, message.tenantId, cues, message.targetLanguage);
    if (!translated) {
      await updateJobStatus(env, jobId, "failed", "translating", "translation failed or cue count mismatch");
      await cleanupScratch(env, jobId);
      await resumeFlow(env, message.pendingId, "failed");
      return;
    }

    await updateJobStatus(env, jobId, "burning_in");
    const srt = cuesToSrt(translated.translatedCues);
    const burned = await burnSubtitles(env, jobId, downloaded.videoKey, srt);
    if (burned.error || !burned.finalKey) {
      await updateJobStatus(env, jobId, "failed", "burning_in", burned.error || "unknown burn-in error");
      await cleanupScratch(env, jobId);
      await resumeFlow(env, message.pendingId, "failed");
      return;
    }

    await updateJobStatus(env, jobId, "success");
    await cleanupScratch(env, jobId);

    const originalText = cues.map((c) => c.text).join(" ");
    await resumeFlow(env, message.pendingId, "success", {
      processed_video_url: `${env.CONTENT_URL}/public/media/${burned.finalKey}`,
      video_transcript: originalText,
      translated_subtitle_text: translated.plainText,
    });
  } catch (err) {
    console.error(JSON.stringify({ event: "video_action_job_error", jobId, error: String(err) }));
    await updateJobStatus(env, jobId, "failed", "unknown", String(err));
    await cleanupScratch(env, jobId);
    await resumeFlow(env, message.pendingId, "failed");
  }
}
