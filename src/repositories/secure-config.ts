import type { Env } from "../types/env.js";

/** Keys that may be managed (entered/rotated) from the admin dashboard. */
export const WEB_MANAGED_SECRETS = [
  "TELEGRAM_BOT_TOKEN",
  "BALE_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "BALE_WEBHOOK_SECRET",
] as const;

export type WebManagedSecret = (typeof WEB_MANAGED_SECRETS)[number];

export interface SecureConfigRow {
  key: string;
  value_encrypted: string;
  updated_at: string;
}

export class SecureConfigRepo {
  constructor(private db: D1Database) {}

  async all(): Promise<SecureConfigRow[]> {
    const res = await this.db.prepare("SELECT * FROM secure_config").all<SecureConfigRow>();
    return res.results ?? [];
  }

  async set(key: string, valueEncrypted: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO secure_config (key, value_encrypted, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value_encrypted = excluded.value_encrypted, updated_at = datetime('now')`,
      )
      .bind(key, valueEncrypted)
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM secure_config WHERE key = ?").bind(key).run();
  }
}

export function secureConfigRepo(env: Env): SecureConfigRepo {
  return new SecureConfigRepo(env.DB);
}
