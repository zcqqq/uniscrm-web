import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executePendingTask } from "../../worker/services/task-executor";
import type { PendingTaskService, PendingTask } from "../../worker/services/pending-tasks";

const ENV = {
  ADMIN_URL: "https://admin.example.com",
  INTERNAL_SECRET: "internal-secret",
  WEB_DB: {} as D1Database,
};

function fakeTaskService(task: PendingTask | null) {
  return {
    getById: vi.fn().mockResolvedValue(task),
    markDone: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  } as unknown as PendingTaskService;
}

function pendingTask(overrides: Partial<PendingTask> = {}): PendingTask {
  return {
    id: "task-1",
    task_type: "provision-db",
    payload: JSON.stringify({ tenant_id: 42 }),
    status: "pending",
    retry_count: 0,
    next_retry_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("executePendingTask", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("provision-db: POSTs to admin's per-tenant provision-db route and marks the task done", async () => {
    const task = pendingTask({ task_type: "provision-db", payload: JSON.stringify({ tenant_id: 42 }) });
    const taskService = fakeTaskService(task);

    await executePendingTask(ENV, taskService, task.id);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://admin.example.com/internal/tenants/42/provision-db",
      expect.objectContaining({
        method: "POST",
        headers: { "X-Internal-Secret": "internal-secret" },
      })
    );
    expect(taskService.markDone).toHaveBeenCalledWith(task.id);
    expect(taskService.markFailed).not.toHaveBeenCalled();
  });

  it("activate-trial: POSTs the tier/days payload and marks the task done", async () => {
    const task = pendingTask({
      task_type: "activate-trial",
      payload: JSON.stringify({ tenant_id: 42, tier: "basic", days: 30 }),
    });
    const taskService = fakeTaskService(task);

    await executePendingTask(ENV, taskService, task.id);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://admin.example.com/internal/subscriptions/activate-trial",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Internal-Secret": "internal-secret" }),
        body: JSON.stringify({ tenant_id: 42, tier: "basic", days: 30 }),
      })
    );
    expect(taskService.markDone).toHaveBeenCalledWith(task.id);
  });

  it("marks the task failed (for cron retry) when the admin call errors", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    const task = pendingTask();
    const taskService = fakeTaskService(task);

    await executePendingTask(ENV, taskService, task.id);

    expect(taskService.markFailed).toHaveBeenCalledWith(task.id);
    expect(taskService.markDone).not.toHaveBeenCalled();
  });

  it("marks unknown task types done without calling out anywhere (no retry loop on garbage)", async () => {
    const task = pendingTask({ task_type: "mystery-type" });
    const taskService = fakeTaskService(task);

    await executePendingTask(ENV, taskService, task.id);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(taskService.markDone).toHaveBeenCalledWith(task.id);
  });

  it("no-ops when the task is missing or already handled", async () => {
    const taskService = fakeTaskService(null);

    await executePendingTask(ENV, taskService, "gone");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(taskService.markDone).not.toHaveBeenCalled();
  });
});
