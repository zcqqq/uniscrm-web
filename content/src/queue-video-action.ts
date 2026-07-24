import type { Env } from "./types";
import { createJob, updateJobStatus } from "./services/video-action/job-store";
import { downloadAndExtract, downloadVideo, burnSubtitles, rotateToVertical, removeFace, faceRatio, probeDimensions } from "./services/video-action/container-client";
import { transcribeAudio } from "./services/video-action/transcribe";
import { translateCues, cuesToSrt } from "./services/video-action/translate";

export interface VideoActionQueueMessage {
  pendingId: string;
  contentId: string;
  tenantId: number;
  videoUrl: string;
  // "check-face"/"check-orientation" are the videoCondition node, not a videoAction -- they
  // share this queue, job table and resume callback rather than duplicating the whole async
  // pipeline. Neither produces an output video: each reports a raw measured value and flow
  // turns that into a true/false branch.
  operation: "add-subtitle" | "rotate-to-vertical" | "remove-face" | "check-face" | "check-orientation";
  targetLanguage: string;
  flowId: string;
  nodeId: string;
  payload: Record<string, unknown>;
}

async function resumeFlow(env: Env, pendingId: string, branch: "success" | "failed", props: Record<string, unknown> = {}, reason?: string): Promise<void> {
  try {
    await fetch(`${env.FLOW_URL}/internal/video-action/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
      // `reason` mirrors the stage + message already written to the job store, so the flow
      // analytics drawer can say WHICH stage failed instead of a bare "Failed". Container
      // stdout isn't queryable, so this callback is the only path that detail can travel.
      body: JSON.stringify({ pendingId, branch, props, reason }),
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

async function processAddSubtitle(env: Env, jobId: string, message: VideoActionQueueMessage): Promise<void> {
  const downloaded = await downloadAndExtract(env, jobId, message.videoUrl);
  if (downloaded.error || !downloaded.videoKey || !downloaded.audioKey) {
    await updateJobStatus(env, jobId, "failed", "downloading", downloaded.error || "unknown download error");
    await cleanupScratch(env, jobId);
    await resumeFlow(env, message.pendingId, "failed", {}, `video_action_failed: downloading — ${downloaded.error || "unknown download error"}`);
    return;
  }

  await updateJobStatus(env, jobId, "transcribing");
  const cues = await transcribeAudio(env, downloaded.audioKey);
  if (!cues) {
    await updateJobStatus(env, jobId, "failed", "transcribing", "no speech detected or transcription error");
    await cleanupScratch(env, jobId);
    await resumeFlow(env, message.pendingId, "failed", {}, "video_action_failed: transcribing — no speech detected or transcription error");
    return;
  }

  await updateJobStatus(env, jobId, "translating");
  const translated = await translateCues(env, message.tenantId, cues, message.targetLanguage);
  if (!translated) {
    await updateJobStatus(env, jobId, "failed", "translating", "translation failed or cue count mismatch");
    await cleanupScratch(env, jobId);
    await resumeFlow(env, message.pendingId, "failed", {}, "video_action_failed: translating — translation failed or cue count mismatch");
    return;
  }

  await updateJobStatus(env, jobId, "burning_in");
  const srt = cuesToSrt(translated.translatedCues);
  const burned = await burnSubtitles(env, jobId, downloaded.videoKey, srt);
  if (burned.error || !burned.finalKey) {
    await updateJobStatus(env, jobId, "failed", "burning_in", burned.error || "unknown burn-in error");
    await cleanupScratch(env, jobId);
    await resumeFlow(env, message.pendingId, "failed", {}, `video_action_failed: burning_in — ${burned.error || "unknown burn-in error"}`);
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
}

async function processRotateToVertical(env: Env, jobId: string, message: VideoActionQueueMessage): Promise<void> {
  const downloaded = await downloadVideo(env, jobId, message.videoUrl);
  if (downloaded.error || !downloaded.videoKey) {
    await updateJobStatus(env, jobId, "failed", "downloading", downloaded.error || "unknown download error");
    await cleanupScratch(env, jobId);
    await resumeFlow(env, message.pendingId, "failed", {}, `video_action_failed: downloading — ${downloaded.error || "unknown download error"}`);
    return;
  }

  await updateJobStatus(env, jobId, "rotating");
  const rotated = await rotateToVertical(env, jobId, downloaded.videoKey);
  if (rotated.error || !rotated.finalKey) {
    await updateJobStatus(env, jobId, "failed", "rotating", rotated.error || "unknown rotate error");
    await cleanupScratch(env, jobId);
    await resumeFlow(env, message.pendingId, "failed", {}, `video_action_failed: rotating — ${rotated.error || "unknown rotate error"}`);
    return;
  }

  await updateJobStatus(env, jobId, "success");
  await cleanupScratch(env, jobId);
  await resumeFlow(env, message.pendingId, "success", {
    processed_video_url: `${env.CONTENT_URL}/public/media/${rotated.finalKey}`,
  });
}

async function processRemoveFace(env: Env, jobId: string, message: VideoActionQueueMessage): Promise<void> {
  const downloaded = await downloadVideo(env, jobId, message.videoUrl);
  if (downloaded.error || !downloaded.videoKey) {
    await updateJobStatus(env, jobId, "failed", "downloading", downloaded.error || "unknown download error");
    await cleanupScratch(env, jobId);
    await resumeFlow(env, message.pendingId, "failed", {}, `video_action_failed: downloading — ${downloaded.error || "unknown download error"}`);
    return;
  }

  await updateJobStatus(env, jobId, "detecting_faces");
  const cut = await removeFace(env, jobId, downloaded.videoKey);
  if (cut.error || !cut.finalKey) {
    await updateJobStatus(env, jobId, "failed", "detecting_faces", cut.error || "unknown remove-face error");
    await cleanupScratch(env, jobId);
    await resumeFlow(env, message.pendingId, "failed", {}, `video_action_failed: detecting_faces — ${cut.error || "unknown remove-face error"}`);
    return;
  }

  await updateJobStatus(env, jobId, "success");
  await cleanupScratch(env, jobId);
  await resumeFlow(env, message.pendingId, "success", {
    processed_video_url: `${env.CONTENT_URL}/public/media/${cut.finalKey}`,
  });
}

async function processCheckFace(env: Env, jobId: string, message: VideoActionQueueMessage): Promise<void> {
  const downloaded = await downloadVideo(env, jobId, message.videoUrl);
  if (downloaded.error || !downloaded.videoKey) {
    await updateJobStatus(env, jobId, "failed", "downloading", downloaded.error || "unknown download error");
    await cleanupScratch(env, jobId);
    await resumeFlow(env, message.pendingId, "failed", {}, `video_action_failed: downloading — ${downloaded.error || "unknown download error"}`);
    return;
  }

  await updateJobStatus(env, jobId, "sampling_faces");
  const sampled = await faceRatio(env, jobId, downloaded.videoKey);
  if (sampled.error || typeof sampled.ratio !== "number") {
    await updateJobStatus(env, jobId, "failed", "sampling_faces", sampled.error || "unknown face-ratio error");
    await cleanupScratch(env, jobId);
    await resumeFlow(env, message.pendingId, "failed", {}, `video_action_failed: sampling_faces — ${sampled.error || "unknown face-ratio error"}`);
    return;
  }

  await updateJobStatus(env, jobId, "success");
  await cleanupScratch(env, jobId);
  // "success" here means "the ratio was measured", not "the condition passed". Comparing the
  // ratio against the node's operator/threshold happens in flow's resume route, which reads
  // them from the graph — this module never learns that a threshold exists.
  await resumeFlow(env, message.pendingId, "success", { face_ratio: sampled.ratio });
}

async function processCheckOrientation(env: Env, jobId: string, message: VideoActionQueueMessage): Promise<void> {
  const downloaded = await downloadVideo(env, jobId, message.videoUrl);
  if (downloaded.error || !downloaded.videoKey) {
    await updateJobStatus(env, jobId, "failed", "downloading", downloaded.error || "unknown download error");
    await cleanupScratch(env, jobId);
    await resumeFlow(env, message.pendingId, "failed", {}, `video_action_failed: downloading — ${downloaded.error || "unknown download error"}`);
    return;
  }

  await updateJobStatus(env, jobId, "probing_dimensions");
  const probed = await probeDimensions(env, jobId, downloaded.videoKey);
  if (probed.error || typeof probed.ratio !== "number") {
    await updateJobStatus(env, jobId, "failed", "probing_dimensions", probed.error || "unknown dimension-probe error");
    await cleanupScratch(env, jobId);
    await resumeFlow(env, message.pendingId, "failed", {}, `video_action_failed: probing_dimensions — ${probed.error || "unknown dimension-probe error"}`);
    return;
  }

  await updateJobStatus(env, jobId, "success");
  await cleanupScratch(env, jobId);
  // "success" here means "the ratio was measured", not "the condition passed". Comparing the
  // ratio against the node's operator/threshold happens in flow's resume route, which reads
  // them from the graph — this module never learns that a threshold exists.
  await resumeFlow(env, message.pendingId, "success", { aspect_ratio: probed.ratio });
}

export async function processVideoActionJob(env: Env, message: VideoActionQueueMessage): Promise<void> {
  let jobId: string;
  try {
    jobId = await createJob(env, {
      pendingId: message.pendingId, contentId: message.contentId,
      tenantId: message.tenantId, operation: message.operation, targetLanguage: message.targetLanguage,
    });
  } catch (err) {
    console.error(JSON.stringify({ event: "video_action_job_create_failed", pendingId: message.pendingId, error: String(err) }));
    await resumeFlow(env, message.pendingId, "failed", {}, `video_action_failed: job_create — ${String(err)}`);
    return;
  }

  try {
    if (message.operation === "rotate-to-vertical") {
      await processRotateToVertical(env, jobId, message);
    } else if (message.operation === "remove-face") {
      await processRemoveFace(env, jobId, message);
    } else if (message.operation === "check-face") {
      await processCheckFace(env, jobId, message);
    } else if (message.operation === "check-orientation") {
      await processCheckOrientation(env, jobId, message);
    } else {
      await processAddSubtitle(env, jobId, message);
    }
  } catch (err) {
    console.error(JSON.stringify({ event: "video_action_job_error", jobId, error: String(err) }));
    try {
      await updateJobStatus(env, jobId, "failed", "unknown", String(err));
    } catch (statusErr) {
      console.error(JSON.stringify({ event: "video_action_job_status_update_failed", jobId, error: String(statusErr) }));
    }
    await cleanupScratch(env, jobId);
    await resumeFlow(env, message.pendingId, "failed", {}, `video_action_failed: unknown — ${String(err)}`);
  }
}
