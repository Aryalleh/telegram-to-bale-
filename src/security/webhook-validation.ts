import type { Env } from "../types/env.js";

/** Constant-time-ish string comparison to avoid trivial timing leaks. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Validate a Telegram webhook request:
 *  - the secret in the URL path must match, AND
 *  - the X-Telegram-Bot-Api-Secret-Token header must match.
 */
export function validateTelegramWebhook(env: Env, pathSecret: string, req: Request): boolean {
  if (!safeEqual(pathSecret, env.TELEGRAM_WEBHOOK_SECRET)) return false;
  const header = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  return safeEqual(header, env.TELEGRAM_WEBHOOK_SECRET);
}

/**
 * Validate a Bale webhook request. Bale does not send a secret-token header, so
 * protection relies on the long unpredictable path secret plus method checks.
 */
export function validateBaleWebhook(env: Env, pathSecret: string, req: Request): boolean {
  if (req.method !== "POST") return false;
  return safeEqual(pathSecret, env.BALE_WEBHOOK_SECRET);
}

/** Bearer-token check for the admin API/dashboard. */
export function validateAdmin(env: Env, req: Request): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1] : new URL(req.url).searchParams.get("token") ?? "";
  return token.length > 0 && safeEqual(token, env.ADMIN_API_SECRET);
}
