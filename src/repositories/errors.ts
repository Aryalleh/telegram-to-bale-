import type { Env, Platform } from "../types/env.js";

export interface SyncError {
  id: number;
  platform: string | null;
  operation: string | null;
  chat_id: string | null;
  message_id: string | null;
  error_code: string | null;
  error_message: string | null;
  payload_summary: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface RecordErrorInput {
  platform?: Platform;
  operation?: string;
  chatId?: string | number;
  messageId?: string | number;
  errorCode?: string | number;
  errorMessage?: string;
  payloadSummary?: string;
}

export class ErrorsRepo {
  constructor(private db: D1Database) {}

  async record(e: RecordErrorInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sync_errors
          (platform, operation, chat_id, message_id, error_code, error_message, payload_summary)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        e.platform ?? null,
        e.operation ?? null,
        e.chatId != null ? String(e.chatId) : null,
        e.messageId != null ? String(e.messageId) : null,
        e.errorCode != null ? String(e.errorCode) : null,
        (e.errorMessage ?? "").slice(0, 1000),
        (e.payloadSummary ?? "").slice(0, 1000),
      )
      .run();
  }

  async recent(limit = 20): Promise<SyncError[]> {
    const res = await this.db
      .prepare("SELECT * FROM sync_errors ORDER BY id DESC LIMIT ?")
      .bind(limit)
      .all<SyncError>();
    return res.results ?? [];
  }

  async countSince(sinceIso: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS c FROM sync_errors WHERE created_at >= ? AND resolved_at IS NULL")
      .bind(sinceIso)
      .first<{ c: number }>();
    return row?.c ?? 0;
  }
}

export function errorsRepo(env: Env): ErrorsRepo {
  return new ErrorsRepo(env.DB);
}
