import type { Env } from "../types/env.js";
import type { Update } from "../types/telegram.js";
import { SyncContext } from "../services/context.js";
import { dispatchUpdate } from "../services/dispatch.js";
import { validateBaleWebhook } from "../security/webhook-validation.js";

/**
 * POST /webhooks/bale/{secret}
 * Receives Bale channel/group updates. Bale's Bot API mirrors Telegram's, so
 * the same dispatch pipeline handles it.
 */
export async function handleBaleWebhook(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  secret: string,
): Promise<Response> {
  const sync = await SyncContext.create(env);
  if (!validateBaleWebhook(sync.secrets.baleWebhookSecret, secret, req)) {
    return new Response("Forbidden", { status: 403 });
  }

  let update: Update;
  try {
    update = (await req.json()) as Update;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  ctx.waitUntil(
    dispatchUpdate(sync, "bale", update).catch((e) => console.error("bale dispatch error", e)),
  );
  return new Response("ok", { status: 200 });
}
