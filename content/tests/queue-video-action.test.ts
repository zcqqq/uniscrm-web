import { describe, it, expect, vi, beforeEach } from "vitest";
import { processVideoActionJob } from "../src/queue-video-action";
import * as jobStore from "../src/services/video-action/job-store";
import * as containerClient from "../src/services/video-action/container-client";
import * as transcribeModule from "../src/services/video-action/transcribe";
import * as translateModule from "../src/services/video-action/translate";

const message = {
  pendingId: "pend1", contentId: "c1", tenantId: 1,
  videoUrl: "https://youtube.com/watch?v=x", targetLanguage: "zh",
  flowId: "f1", nodeId: "n1", payload: {},
};

function makeEnv() {
  return {
    FLOW_URL: "https://flow-dev.uni-scrm.com",
    INTERNAL_SECRET: "test-secret",
    MEDIA_BUCKET: { delete: vi.fn() },
  } as any;
}

describe("processVideoActionJob", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    vi.spyOn(jobStore, "createJob").mockResolvedValue("job1");
    vi.spyOn(jobStore, "updateJobStatus").mockResolvedValue(undefined);
  });

  it("resolves success end-to-end and posts branch='success' to flow", async () => {
    vi.spyOn(containerClient, "downloadAndExtract").mockResolvedValue({ videoKey: "v1", audioKey: "a1" });
    vi.spyOn(transcribeModule, "transcribeAudio").mockResolvedValue([{ start: "00:00:00.000", end: "00:00:01.000", text: "hi" }]);
    vi.spyOn(translateModule, "translateCues").mockResolvedValue({ translatedCues: [{ start: "00:00:00.000", end: "00:00:01.000", text: "你好" }], plainText: "你好" });
    vi.spyOn(containerClient, "burnSubtitles").mockResolvedValue({ finalKey: "final-xyz.mp4" });

    await processVideoActionJob(makeEnv(), message);

    expect(jobStore.updateJobStatus).toHaveBeenCalledWith(expect.anything(), "job1", "success");
    const resumeCall = (fetch as any).mock.calls.find((c: any[]) => c[0].includes("/internal/video-action/resume"));
    expect(resumeCall).toBeDefined();
    const body = JSON.parse(resumeCall[1].body);
    expect(body.branch).toBe("success");
    expect(body.props.processed_video_url).toContain("final-xyz.mp4");
  });

  it("resolves failed when download fails, without calling transcribe", async () => {
    vi.spyOn(containerClient, "downloadAndExtract").mockResolvedValue({ error: "yt-dlp failed" });
    const transcribeSpy = vi.spyOn(transcribeModule, "transcribeAudio");

    await processVideoActionJob(makeEnv(), message);

    expect(transcribeSpy).not.toHaveBeenCalled();
    expect(jobStore.updateJobStatus).toHaveBeenCalledWith(expect.anything(), "job1", "failed", "downloading", "yt-dlp failed");
    const resumeCall = (fetch as any).mock.calls.find((c: any[]) => c[0].includes("/internal/video-action/resume"));
    const body = JSON.parse(resumeCall[1].body);
    expect(body.branch).toBe("failed");
  });

  it("resolves failed on a cue-count mismatch during translation", async () => {
    vi.spyOn(containerClient, "downloadAndExtract").mockResolvedValue({ videoKey: "v1", audioKey: "a1" });
    vi.spyOn(transcribeModule, "transcribeAudio").mockResolvedValue([{ start: "00:00:00.000", end: "00:00:01.000", text: "hi" }]);
    vi.spyOn(translateModule, "translateCues").mockResolvedValue(null);

    await processVideoActionJob(makeEnv(), message);

    expect(jobStore.updateJobStatus).toHaveBeenCalledWith(expect.anything(), "job1", "failed", "translating", expect.any(String));
  });

  it("never throws even if a step throws unexpectedly", async () => {
    vi.spyOn(containerClient, "downloadAndExtract").mockRejectedValue(new Error("boom"));
    await expect(processVideoActionJob(makeEnv(), message)).resolves.not.toThrow();
  });

  it("never throws even if updateJobStatus itself rejects inside the outer catch block", async () => {
    vi.spyOn(containerClient, "downloadAndExtract").mockRejectedValue(new Error("boom"));
    (jobStore.updateJobStatus as any).mockImplementation((_env: any, _jobId: string, status: string) => {
      if (status === "failed") {
        return Promise.reject(new Error("D1 write failed"));
      }
      return Promise.resolve(undefined);
    });

    await expect(processVideoActionJob(makeEnv(), message)).resolves.not.toThrow();

    // Even though updateJobStatus("failed") rejected, cleanup and the flow callback must still happen
    // so the queue message still gets acknowledged with no lingering side effects skipped.
    const resumeCall = (fetch as any).mock.calls.find((c: any[]) => c[0].includes("/internal/video-action/resume"));
    expect(resumeCall).toBeDefined();
    const body = JSON.parse(resumeCall[1].body);
    expect(body.branch).toBe("failed");
  });

  it("resolves failed and notifies flow when createJob itself throws, without ever calling downloadAndExtract", async () => {
    (jobStore.createJob as any).mockRejectedValue(new Error("D1 write failed"));
    const downloadSpy = vi.spyOn(containerClient, "downloadAndExtract");

    await expect(processVideoActionJob(makeEnv(), message)).resolves.not.toThrow();

    expect(downloadSpy).not.toHaveBeenCalled();
    const resumeCall = (fetch as any).mock.calls.find((c: any[]) => c[0].includes("/internal/video-action/resume"));
    expect(resumeCall).toBeDefined();
    const body = JSON.parse(resumeCall[1].body);
    expect(body.branch).toBe("failed");
  });
});
