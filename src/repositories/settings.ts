import type { Env } from "../types/env.js";

/**
 * Default configurable behavior. Anything here can be overridden by a row in
 * the `settings` table (edited from the admin dashboard) without code changes.
 */
export const DEFAULT_SETTINGS: Record<string, string> = {
  // Feature toggles
  sync_posts: "true",
  sync_comments: "true",
  sync_bale_to_telegram_replies: "true",
  sync_telegram_to_bale: "true",
  sync_bale_to_telegram: "true",

  // Global pause switches (admin controlled)
  paused: "false",
  paused_posts: "false",
  paused_comments: "false",

  // Presentation
  label_from_telegram: "true",
  label_from_bale: "true",
  add_source_links: "true",
  include_usernames: "true",
  include_profile_links: "true",
  include_timestamps: "false",

  // Media
  transfer_comment_media: "true",
  transfer_standalone_bale_messages: "false",
  mirror_url_buttons: "true",
  send_silently: "false",
  media_fallback_mode: "document", // document | source_link | notify_admin
  unsupported_content_message: "This content type could not be transferred. See the original message.",

  // Ops
  admin_notification_chat: "",
  max_retry_count: "4",

  // Allowlists (comma-separated chat ids). Empty => derived from connections.
  allowed_telegram_channel_id: "",
  allowed_telegram_discussion_id: "",
  allowed_bale_channel_id: "",
  allowed_bale_discussion_id: "",

  // Admin user ids allowed to run bot commands (comma-separated).
  admin_telegram_user_ids: "",
  admin_bale_user_ids: "",
};

export class SettingsRepo {
  private cache: Map<string, string> | null = null;
  constructor(private db: D1Database) {}

  private async load(): Promise<Map<string, string>> {
    if (this.cache) return this.cache;
    const map = new Map<string, string>(Object.entries(DEFAULT_SETTINGS));
    const rows = await this.db
      .prepare("SELECT key, value FROM settings")
      .all<{ key: string; value: string | null }>();
    for (const r of rows.results ?? []) {
      if (r.value !== null) map.set(r.key, r.value);
    }
    this.cache = map;
    return map;
  }

  async getAll(): Promise<Record<string, string>> {
    const map = await this.load();
    return Object.fromEntries(map.entries());
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.load()).get(key);
  }

  async getBool(key: string): Promise<boolean> {
    return (await this.get(key)) === "true";
  }

  async getNumber(key: string, fallback = 0): Promise<number> {
    const v = await this.get(key);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      )
      .bind(key, value)
      .run();
    this.cache = null;
  }

  async setMany(entries: Record<string, string>): Promise<void> {
    const stmts = Object.entries(entries).map(([k, v]) =>
      this.db
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        )
        .bind(k, v),
    );
    if (stmts.length) await this.db.batch(stmts);
    this.cache = null;
  }
}

export function settingsRepo(env: Env): SettingsRepo {
  return new SettingsRepo(env.DB);
}
