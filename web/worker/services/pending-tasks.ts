export interface PendingTask {
  id: string;
  task_type: string;
  payload: string;
  status: string;
  retry_count: number;
  next_retry_at: string;
  created_at: string;
}

const RETRY_DELAYS_MS = [0, 60_000, 300_000, 1_800_000, 7_200_000];

export class PendingTaskService {
  constructor(private db: D1Database) {}

  async create(taskType: string, payload: object): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db
      .prepare(
        "INSERT INTO pending_tasks (id, task_type, payload, status, retry_count, next_retry_at, created_at) VALUES (?, ?, ?, 'pending', 0, ?, ?)"
      )
      .bind(id, taskType, JSON.stringify(payload), now, now)
      .run();
    return id;
  }

  async getById(id: string): Promise<PendingTask | null> {
    return this.db
      .prepare("SELECT * FROM pending_tasks WHERE id = ?")
      .bind(id)
      .first<PendingTask>();
  }

  async markDone(id: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM pending_tasks WHERE id = ?")
      .bind(id)
      .run();
  }

  async markFailed(id: string): Promise<void> {
    const task = await this.getById(id);
    if (!task) return;
    const nextRetry = task.retry_count + 1;
    if (nextRetry >= 5) {
      await this.db
        .prepare("UPDATE pending_tasks SET status = 'failed', retry_count = ? WHERE id = ?")
        .bind(nextRetry, id)
        .run();
      return;
    }
    const delayMs = RETRY_DELAYS_MS[nextRetry] || 7_200_000;
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    await this.db
      .prepare("UPDATE pending_tasks SET retry_count = ?, next_retry_at = ? WHERE id = ?")
      .bind(nextRetry, nextRetryAt, id)
      .run();
  }

  async getRetryable(now: string, limit = 20): Promise<PendingTask[]> {
    const result = await this.db
      .prepare(
        "SELECT * FROM pending_tasks WHERE status = 'pending' AND next_retry_at <= ? ORDER BY next_retry_at LIMIT ?"
      )
      .bind(now, limit)
      .all<PendingTask>();
    return result.results;
  }
}
