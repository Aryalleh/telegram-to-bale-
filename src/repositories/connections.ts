import type { Env } from "../types/env.js";

export interface ChannelConnection {
  id: number;
  telegram_channel_id: string | null;
  telegram_channel_username: string | null;
  telegram_discussion_id: string | null;
  bale_channel_id: string | null;
  bale_channel_username: string | null;
  bale_discussion_id: string | null;
  is_enabled: number;
  created_at: string;
  updated_at: string;
}

export type ConnectionInput = Omit<
  ChannelConnection,
  "id" | "created_at" | "updated_at" | "is_enabled"
> & { is_enabled?: boolean };

export class ConnectionsRepo {
  constructor(private db: D1Database) {}

  async list(): Promise<ChannelConnection[]> {
    const res = await this.db
      .prepare("SELECT * FROM channel_connections ORDER BY id")
      .all<ChannelConnection>();
    return res.results ?? [];
  }

  async getEnabled(): Promise<ChannelConnection[]> {
    const res = await this.db
      .prepare("SELECT * FROM channel_connections WHERE is_enabled = 1 ORDER BY id")
      .all<ChannelConnection>();
    return res.results ?? [];
  }

  /** Find the connection that owns a given chat id on either platform. */
  async findByChat(chatId: string): Promise<ChannelConnection | null> {
    const res = await this.db
      .prepare(
        `SELECT * FROM channel_connections
         WHERE telegram_channel_id = ?1 OR telegram_discussion_id = ?1
            OR bale_channel_id = ?1 OR bale_discussion_id = ?1
         LIMIT 1`,
      )
      .bind(chatId)
      .first<ChannelConnection>();
    return res ?? null;
  }

  async upsert(input: ConnectionInput & { id?: number }): Promise<number> {
    if (input.id) {
      await this.db
        .prepare(
          `UPDATE channel_connections SET
             telegram_channel_id = ?, telegram_channel_username = ?, telegram_discussion_id = ?,
             bale_channel_id = ?, bale_channel_username = ?, bale_discussion_id = ?,
             is_enabled = ?, updated_at = datetime('now')
           WHERE id = ?`,
        )
        .bind(
          input.telegram_channel_id,
          input.telegram_channel_username,
          input.telegram_discussion_id,
          input.bale_channel_id,
          input.bale_channel_username,
          input.bale_discussion_id,
          input.is_enabled === false ? 0 : 1,
          input.id,
        )
        .run();
      return input.id;
    }
    const res = await this.db
      .prepare(
        `INSERT INTO channel_connections
           (telegram_channel_id, telegram_channel_username, telegram_discussion_id,
            bale_channel_id, bale_channel_username, bale_discussion_id, is_enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.telegram_channel_id,
        input.telegram_channel_username,
        input.telegram_discussion_id,
        input.bale_channel_id,
        input.bale_channel_username,
        input.bale_discussion_id,
        input.is_enabled === false ? 0 : 1,
      )
      .run();
    return res.meta.last_row_id as number;
  }

  async delete(id: number): Promise<void> {
    await this.db.prepare("DELETE FROM channel_connections WHERE id = ?").bind(id).run();
  }
}

export function connectionsRepo(env: Env): ConnectionsRepo {
  return new ConnectionsRepo(env.DB);
}
