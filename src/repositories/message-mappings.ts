import type { Env, MessageSource } from "../types/env.js";

export type MessageType =
  | "channel_post"
  | "channel_album_item"
  | "comment"
  | "reply"
  | "media_fallback"
  | "system_notice";

export type MappingStatus =
  | "active"
  | "manually_deleted"
  | "missing_telegram"
  | "missing_bale"
  | "outdated";

export interface MessageMapping {
  id: number;
  connection_id: number | null;
  message_type: MessageType;
  source_platform: MessageSource;
  telegram_chat_id: string | null;
  telegram_message_id: string | null;
  telegram_thread_id: string | null;
  telegram_media_group_id: string | null;
  bale_chat_id: string | null;
  bale_message_id: string | null;
  bale_media_group_id: string | null;
  telegram_discussion_message_id: string | null;
  bale_discussion_message_id: string | null;
  parent_mapping_id: number | null;
  content_hash: string | null;
  status: MappingStatus;
  created_at: string;
  updated_at: string;
}

export type NewMapping = Partial<
  Omit<MessageMapping, "id" | "created_at" | "updated_at">
> & { message_type: MessageType; source_platform: MessageSource };

export class MappingsRepo {
  constructor(private db: D1Database) {}

  async create(m: NewMapping): Promise<number> {
    const res = await this.db
      .prepare(
        `INSERT INTO message_mappings
          (connection_id, message_type, source_platform,
           telegram_chat_id, telegram_message_id, telegram_thread_id, telegram_media_group_id,
           bale_chat_id, bale_message_id, bale_media_group_id,
           parent_mapping_id, content_hash, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        m.connection_id ?? null,
        m.message_type,
        m.source_platform,
        m.telegram_chat_id ?? null,
        m.telegram_message_id ?? null,
        m.telegram_thread_id ?? null,
        m.telegram_media_group_id ?? null,
        m.bale_chat_id ?? null,
        m.bale_message_id ?? null,
        m.bale_media_group_id ?? null,
        m.parent_mapping_id ?? null,
        m.content_hash ?? null,
        m.status ?? "active",
      )
      .run();
    return res.meta.last_row_id as number;
  }

  async byId(id: number): Promise<MessageMapping | null> {
    return (
      (await this.db
        .prepare("SELECT * FROM message_mappings WHERE id = ?")
        .bind(id)
        .first<MessageMapping>()) ?? null
    );
  }

  async byTelegram(chatId: string, messageId: string): Promise<MessageMapping | null> {
    return (
      (await this.db
        .prepare(
          "SELECT * FROM message_mappings WHERE telegram_chat_id = ? AND telegram_message_id = ? LIMIT 1",
        )
        .bind(chatId, messageId)
        .first<MessageMapping>()) ?? null
    );
  }

  async byBale(chatId: string, messageId: string): Promise<MessageMapping | null> {
    return (
      (await this.db
        .prepare(
          "SELECT * FROM message_mappings WHERE bale_chat_id = ? AND bale_message_id = ? LIMIT 1",
        )
        .bind(chatId, messageId)
        .first<MessageMapping>()) ?? null
    );
  }

  /** Look up by message id on either platform (for /find_mapping). */
  async byAnyMessageId(messageId: string): Promise<MessageMapping[]> {
    const res = await this.db
      .prepare(
        "SELECT * FROM message_mappings WHERE telegram_message_id = ?1 OR bale_message_id = ?1",
      )
      .bind(messageId)
      .all<MessageMapping>();
    return res.results ?? [];
  }

  async setBaleSide(
    id: number,
    baleChatId: string,
    baleMessageId: string,
    baleMediaGroupId?: string | null,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE message_mappings
         SET bale_chat_id = ?, bale_message_id = ?, bale_media_group_id = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .bind(baleChatId, baleMessageId, baleMediaGroupId ?? null, id)
      .run();
  }

  async setTelegramSide(
    id: number,
    tgChatId: string,
    tgMessageId: string,
    tgThreadId?: string | null,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE message_mappings
         SET telegram_chat_id = ?, telegram_message_id = ?, telegram_thread_id = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .bind(tgChatId, tgMessageId, tgThreadId ?? null, id)
      .run();
  }

  /** Record the discussion-group auto-forward message id of a channel post. */
  async setDiscussionMessageId(id: number, platform: "telegram" | "bale", discussionMsgId: string): Promise<void> {
    const col = platform === "telegram" ? "telegram_discussion_message_id" : "bale_discussion_message_id";
    await this.db
      .prepare(`UPDATE message_mappings SET ${col} = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(discussionMsgId, id)
      .run();
  }

  async setContentHash(id: number, hash: string): Promise<void> {
    await this.db
      .prepare("UPDATE message_mappings SET content_hash = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(hash, id)
      .run();
  }

  async setStatus(id: number, status: MappingStatus): Promise<void> {
    await this.db
      .prepare("UPDATE message_mappings SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(status, id)
      .run();
  }

  async listByMediaGroup(
    platform: "telegram" | "bale",
    mediaGroupId: string,
  ): Promise<MessageMapping[]> {
    const col = platform === "telegram" ? "telegram_media_group_id" : "bale_media_group_id";
    const res = await this.db
      .prepare(`SELECT * FROM message_mappings WHERE ${col} = ? ORDER BY id`)
      .bind(mediaGroupId)
      .all<MessageMapping>();
    return res.results ?? [];
  }

  /**
   * Most recent channel_post mapping for a connection still missing its
   * discussion-forward id on `platform`. Used as a fallback to link an
   * auto-forwarded post copy when the platform omits forward references. Does
   * not require the platform-side message id to be recorded yet (it may still
   * be in flight), so it is robust against send/echo ordering.
   */
  async latestPostAwaitingDiscussion(
    platform: "telegram" | "bale",
    connectionId: number,
  ): Promise<MessageMapping | null> {
    const discCol = platform === "telegram" ? "telegram_discussion_message_id" : "bale_discussion_message_id";
    return (
      (await this.db
        .prepare(
          `SELECT * FROM message_mappings
           WHERE message_type = 'channel_post' AND connection_id = ? AND ${discCol} IS NULL
           ORDER BY id DESC LIMIT 1`,
        )
        .bind(connectionId)
        .first<MessageMapping>()) ?? null
    );
  }

  /**
   * A recently-created channel_post mapping whose `sourceSide` message id is not
   * yet recorded but whose opposite side is — i.e. a mirror we just sent to
   * `sourceSide` that is now echoing back before its id was stored. Matching by
   * content fingerprint makes loop prevention robust against the send/echo race.
   */
  async findPendingChannelMirror(
    connectionId: number,
    sourceSide: "telegram" | "bale",
    contentHash: string,
  ): Promise<MessageMapping | null> {
    const nullCol = sourceSide === "telegram" ? "telegram_message_id" : "bale_message_id";
    const setCol = sourceSide === "telegram" ? "bale_message_id" : "telegram_message_id";
    return (
      (await this.db
        .prepare(
          `SELECT * FROM message_mappings
           WHERE message_type = 'channel_post' AND connection_id = ?
             AND ${nullCol} IS NULL AND ${setCol} IS NOT NULL AND content_hash = ?
             AND created_at >= datetime('now', '-300 seconds')
           ORDER BY id DESC LIMIT 1`,
        )
        .bind(connectionId, contentHash)
        .first<MessageMapping>()) ?? null
    );
  }

  /** Recent channel_post for this connection matching a content fingerprint and
   * still missing its discussion id on `platform` (content-based auto-forward
   * detection when the platform omits is_automatic_forward / forward refs). */
  async recentPostByHashMissingDiscussion(
    connectionId: number,
    platform: "telegram" | "bale",
    contentHash: string,
  ): Promise<MessageMapping | null> {
    const discCol = platform === "telegram" ? "telegram_discussion_message_id" : "bale_discussion_message_id";
    return (
      (await this.db
        .prepare(
          `SELECT * FROM message_mappings
           WHERE message_type = 'channel_post' AND connection_id = ? AND content_hash = ?
             AND ${discCol} IS NULL AND created_at >= datetime('now', '-900 seconds')
           ORDER BY id DESC LIMIT 1`,
        )
        .bind(connectionId, contentHash)
        .first<MessageMapping>()) ?? null
    );
  }

  /** Any channel_post for this connection matching a content fingerprint
   * (used to resolve which post a comment threads under). */
  async channelPostByHash(connectionId: number, contentHash: string): Promise<MessageMapping | null> {
    return (
      (await this.db
        .prepare(
          `SELECT * FROM message_mappings
           WHERE message_type = 'channel_post' AND connection_id = ? AND content_hash = ?
           ORDER BY id DESC LIMIT 1`,
        )
        .bind(connectionId, contentHash)
        .first<MessageMapping>()) ?? null
    );
  }

  async recent(limit = 20): Promise<MessageMapping[]> {
    const res = await this.db
      .prepare("SELECT * FROM message_mappings ORDER BY id DESC LIMIT ?")
      .bind(limit)
      .all<MessageMapping>();
    return res.results ?? [];
  }

  async countByType(messageType: MessageType, sinceIso?: string): Promise<number> {
    const q = sinceIso
      ? this.db
          .prepare(
            "SELECT COUNT(*) AS c FROM message_mappings WHERE message_type = ? AND created_at >= ?",
          )
          .bind(messageType, sinceIso)
      : this.db
          .prepare("SELECT COUNT(*) AS c FROM message_mappings WHERE message_type = ?")
          .bind(messageType);
    const row = await q.first<{ c: number }>();
    return row?.c ?? 0;
  }
}

export function mappingsRepo(env: Env): MappingsRepo {
  return new MappingsRepo(env.DB);
}
