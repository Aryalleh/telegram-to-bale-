import type { Env } from "../types/env.js";

export type JobStatus = "pending" | "in_progress" | "done" | "failed" | "dead";

export interface SyncJob {
  id: number;
  operation: string;
  payload: string;
  attempt_count: number;
  next_attempt_at: string;
  last_error: string | null;
  status: JobStatus;
  created_at: string;
  updated_at: string;
}

export class SyncJobsRepo {
  constructor(private db: D1Database) {}

  async enqueue(operation: string, payload: unknown, delaySeconds = 0): Promise<number> {
    const res = await this.db
      .prepare(
        `INSERT INTO sync_jobs (operation, payload, next_attempt_at)
         VALUES (?, ?, datetime('now', ?))`,
      )
      .bind(operation, JSON.stringify(payload), `+${Math.max(0, delaySeconds)} seconds`)
      .run();
    return res.meta.last_row_id as number;
  }

  async due(limit = 10): Promise<SyncJob[]> {
    const res = await this.db
      .prepare(
        `SELECT * FROM sync_jobs
         WHERE status = 'pending' AND next_attempt_at <= datetime('now')
         ORDER BY next_attempt_at ASC LIMIT ?`,
      )
      .bind(limit)
      .all<SyncJob>();
    return res.results ?? [];
  }

  async markInProgress(id: number): Promise<void> {
    await this.db
      .prepare("UPDATE sync_jobs SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?")
      .bind(id)
      .run();
  }

  async markDone(id: number): Promise<void> {
    await this.db
      .prepare("UPDATE sync_jobs SET status = 'done', updated_at = datetime('now') WHERE id = ?")
      .bind(id)
      .run();
  }

  async reschedule(id: number, attemptCount: number, delaySeconds: number, error: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE sync_jobs
         SET status = 'pending', attempt_count = ?, last_error = ?,
             next_attempt_at = datetime('now', ?), updated_at = datetime('now')
         WHERE id = ?`,
      )
      .bind(attemptCount, error.slice(0, 500), `+${Math.max(0, delaySeconds)} seconds`, id)
      .run();
  }

  async markDead(id: number, error: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE sync_jobs SET status = 'dead', last_error = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .bind(error.slice(0, 500), id)
      .run();
  }

  async retryFailed(): Promise<number> {
    const res = await this.db
      .prepare(
        `UPDATE sync_jobs SET status = 'pending', next_attempt_at = datetime('now'), updated_at = datetime('now')
         WHERE status IN ('failed', 'dead')`,
      )
      .run();
    return res.meta.changes ?? 0;
  }

  async countPending(): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS c FROM sync_jobs WHERE status IN ('pending','in_progress')")
      .first<{ c: number }>();
    return row?.c ?? 0;
  }
}

export function syncJobsRepo(env: Env): SyncJobsRepo {
  return new SyncJobsRepo(env.DB);
}
