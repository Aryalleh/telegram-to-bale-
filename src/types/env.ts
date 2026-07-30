/**
 * Cloudflare Worker environment bindings.
 *
 * Secrets are injected at runtime by Cloudflare and are never committed to the
 * repository. See wrangler.jsonc for the list of required secrets.
 */
export interface Env {
  /** D1 database binding (see wrangler.jsonc). */
  DB: D1Database;

  // --- Secrets (wrangler secret put ...) ---
  TELEGRAM_BOT_TOKEN: string;
  BALE_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  BALE_WEBHOOK_SECRET: string;
  ADMIN_API_SECRET: string;

  // --- Vars (wrangler.jsonc) ---
  TELEGRAM_API_BASE: string;
  BALE_API_BASE: string;

  // --- Static assets (admin dashboard) ---
  ASSETS: Fetcher;

  // --- Optional bindings ---
  SYNC_QUEUE?: Queue<unknown>;
  MEDIA_BUCKET?: R2Bucket;
}

/** The two platforms the system bridges. */
export type Platform = "telegram" | "bale";

/**
 * Where a synchronized message originated. Used for loop prevention so a
 * bot-generated mirror is never treated as a fresh user message.
 */
export type MessageSource =
  | "telegram_user"
  | "telegram_bot_mirror"
  | "bale_user"
  | "bale_bot_mirror";
