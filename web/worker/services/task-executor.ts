import { PendingTaskService } from "./pending-tasks";

interface TaskEnv {
  ADMIN_URL: string;
  INTERNAL_SECRET: string;
  WEB_DB: D1Database;
}

export async function executePendingTask(
  env: TaskEnv,
  taskService: PendingTaskService,
  taskId: string
): Promise<void> {
  const task = await taskService.getById(taskId);
  if (!task || task.status !== "pending") return;

  const payload = JSON.parse(task.payload);

  try {
    let res: Response;
    if (task.task_type === "provision-db") {
      res = await fetch(
        `${env.ADMIN_URL}/internal/tenants/${payload.tenant_id}/provision-db`,
        {
          method: "POST",
          headers: { "X-Internal-Secret": env.INTERNAL_SECRET },
        }
      );
    } else if (task.task_type === "activate-trial") {
      res = await fetch(
        `${env.ADMIN_URL}/internal/subscriptions/activate-trial`,
        {
          method: "POST",
          headers: {
            "X-Internal-Secret": env.INTERNAL_SECRET,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            tenant_id: payload.tenant_id,
            tier: payload.tier,
            days: payload.days,
          }),
        }
      );
    } else {
      console.error(`Unknown task type: ${task.task_type}`);
      await taskService.markDone(taskId);
      return;
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    await taskService.markDone(taskId);
  } catch (e) {
    console.error(`Task ${taskId} (${task.task_type}) failed [retry ${task.retry_count}]:`, e);
    await taskService.markFailed(taskId);
  }
}
