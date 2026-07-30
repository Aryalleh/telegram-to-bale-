import type { Env } from "../types/env.js";
import type { Update } from "../types/telegram.js";
import { SyncContext } from "../services/context.js";
import { dispatchUpdate } from "../services/dispatch.js";
import { validateTelegramWebhook } from "../security/webhook-validation.js";

/**
 * POST /webhooks/telegram/{secret}
 * Receives Telegram channel/group updates. Responds 200 immediately and does
 * the sync work in the background (ctx.waitUntil) so Telegram never retries due
 * to slow processing.
 */
export async function handleTelegramWebhook(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  secret: string,
): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const sync = await SyncContext.create(env);
  if (!validateTelegramWebhook(sync.secrets.telegramWebhookSecret, secret, req)) {
    return new Response("Forbidden", { status: 403 });
  }

  let update: Update;
  try {
    update = (await req.json()) as Update;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  ctx.waitUntil(
    dispatchUpdate(sync, "telegram", update).catch((e) => console.error("telegram dispatch error", e)),
  );
  return new Response("ok", { status: 200 });
}
