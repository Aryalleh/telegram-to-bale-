import type { Env, Platform } from "../types/env.js";

/**
 * Idempotency guard. `claim` atomically records that we are handling an update
 * and returns false if it was already claimed (duplicate delivery).
 */
export class ProcessedUpdatesRepo {
  constructor(private db: D1Database) {}

  /**
   * Attempt to claim an update for processing.
   * @returns true if this is the first time we've seen it, false if duplicate.
   */
  async claim(platform: Platform, updateId: string | number): Promise<boolean> {
    try {
      const res = await this.db
        .prepare(
          "INSERT INTO processed_updates (platform, update_id, status) VALUES (?, ?, 'received')",
        )
        .bind(platform, String(updateId))
        .run();
      return res.success;
    } catch {
      // Unique constraint violation => already claimed.
      return false;
    }
  }

  async markProcessed(platform: Platform, updateId: string | number, status = "processed"): Promise<void> {
    await this.db
      .prepare(
        "UPDATE processed_updates SET status = ?, processed_at = datetime('now') WHERE platform = ? AND update_id = ?",
      )
      .bind(status, platform, String(updateId))
      .run();
  }

  async release(platform: Platform, updateId: string | number): Promise<void> {
    // On hard failure, remove the claim so a retried delivery can be reprocessed.
    await this.db
      .prepare("DELETE FROM processed_updates WHERE platform = ? AND update_id = ?")
      .bind(platform, String(updateId))
      .run();
  }
}

export function processedUpdatesRepo(env: Env): ProcessedUpdatesRepo {
  return new ProcessedUpdatesRepo(env.DB);
}
