import { describe, it, expect, vi } from "vitest";
import { createJob, updateJobStatus } from "../../../src/services/video-action/job-store";

function makeEnv() {
  const runs: { sql: string; args: unknown[] }[] = [];
  return {
    env: {
      CONTENT_DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            run: async () => { runs.push({ sql, args }); return { success: true }; },
          }),
        }),
      } as any,
    },
    runs,
  };
}

describe("video-action job-store", () => {
  it("createJob inserts a row with job_status='downloading' and returns its id", async () => {
    const { env, runs } = makeEnv();
    const jobId = await createJob(env, {
      pendingId: "p1", contentId: "c1", tenantId: 1, operation: "add-subtitle", targetLanguage: "zh",
    });
    expect(typeof jobId).toBe("string");
    expect(runs[0].sql).toContain("INSERT INTO video_action_jobs");
    expect(runs[0].args).toContain("downloading");
  });

  it("createJob persists the given operation", async () => {
    const { env, runs } = makeEnv();
    await createJob(env, {
      pendingId: "p2", contentId: "c2", tenantId: 1, operation: "rotate-to-vertical", targetLanguage: "",
    });
    expect(runs[0].args).toContain("rotate-to-vertical");
  });

  it("updateJobStatus updates status, failed_step, and error", async () => {
    const { env, runs } = makeEnv();
    await updateJobStatus(env, "job1", "failed", "downloading", "yt-dlp exited 1");
    expect(runs[0].sql).toContain("UPDATE video_action_jobs");
    expect(runs[0].args).toEqual(expect.arrayContaining(["failed", "downloading", "yt-dlp exited 1", "job1"]));
  });
});
