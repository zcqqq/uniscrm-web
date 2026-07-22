import type { Env } from "../../types";

export type JobStatus =
  | "downloading"
  | "transcribing"
  | "translating"
  | "burning_in"
  | "rotating"
  | "detecting_faces"
  | "sampling_faces"
  | "success"
  | "failed";

export interface CreateJobParams {
  pendingId: string;
  contentId: string;
  tenantId: number;
  operation: string;
  targetLanguage: string;
}

export async function createJob(env: Env, params: CreateJobParams): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.CONTENT_DB.prepare(
    `INSERT INTO video_action_jobs (id, pending_id, content_id, tenant_id, operation, target_language, job_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, params.pendingId, params.contentId, params.tenantId, params.operation, params.targetLanguage, "downloading", now, now).run();
  return id;
}

export async function updateJobStatus(
  env: Env,
  jobId: string,
  status: JobStatus,
  failedStep?: string,
  error?: string
): Promise<void> {
  const now = new Date().toISOString();
  await env.CONTENT_DB.prepare(
    `UPDATE video_action_jobs SET job_status = ?, failed_step = ?, error = ?, updated_at = ? WHERE id = ?`
  ).bind(status, failedStep || null, error || null, now, jobId).run();
}
