import type { Env } from "../types/env.js";
import { SyncContext } from "../services/context.js";
import { snapshot, buildStats } from "../services/status.js";
import { validateAdmin } from "../security/webhook-validation.js";
import { encryptValue } from "../security/crypto.js";
import { WEB_MANAGED_SECRETS } from "../repositories/secure-config.js";
import { json } from "./health.js";

/**
 * Admin JSON API. Every endpoint requires a Bearer token equal to
 * ADMIN_API_SECRET. Bot tokens themselves are Cloudflare secrets and are never
 * read or written here — only their presence is reported.
 */
export async function handleAdmin(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  subPath: string,
): Promise<Response> {
  if (!validateAdmin(env, req)) {
    return json({ error: "unauthorized" }, 401);
  }
  const sync = await SyncContext.create(env);
  const method = req.method.toUpperCase();

  try {
    // --- Status & overview ---
    if (subPath === "status" && method === "GET") {
      const s = await snapshot(sync);
      const [connections, settings, errors, mappings] = await Promise.all([
        sync.connections.list(),
        sync.settings.getAll(),
        sync.errors.recent(15),
        sync.mappings.recent(15),
      ]);
      return json({
        snapshot: s,
        secrets: sync.secrets.sources,
        connections,
        settings,
        recent_errors: errors,
        recent_mappings: mappings,
      });
    }

    // --- Dashboard-managed secrets (encrypted at rest in D1) ---
    if (subPath === "secrets" && method === "GET") {
      // Never return values — only where each secret currently comes from.
      return json({ sources: sync.secrets.sources, managed: WEB_MANAGED_SECRETS });
    }
    if (subPath === "secrets" && method === "POST") {
      if (!env.ADMIN_API_SECRET) {
        return json({ error: "ADMIN_API_SECRET must be set (via wrangler) before storing secrets from the web." }, 400);
      }
      const body = (await req.json()) as Record<string, unknown>;
      const saved: string[] = [];
      for (const key of WEB_MANAGED_SECRETS) {
        const v = body[key];
        if (typeof v === "string" && v.trim().length > 0) {
          const enc = await encryptValue(env.ADMIN_API_SECRET, v.trim());
          await sync.secureConfig.set(key, enc);
          saved.push(key);
        }
      }
      const refreshed = await SyncContext.create(env);
      return json({ ok: true, saved, sources: refreshed.secrets.sources });
    }
    if (subPath.startsWith("secrets/") && method === "DELETE") {
      const key = subPath.split("/")[1];
      if (!(WEB_MANAGED_SECRETS as readonly string[]).includes(key)) {
        return json({ error: "unknown secret" }, 400);
      }
      await sync.secureConfig.delete(key);
      const refreshed = await SyncContext.create(env);
      return json({ ok: true, sources: refreshed.secrets.sources });
    }

    if (subPath === "stats" && method === "GET") {
      return json({ stats: await buildStats(sync) });
    }

    // --- Settings ---
    if (subPath === "settings" && method === "GET") {
      return json({ settings: await sync.settings.getAll() });
    }
    if (subPath === "settings" && method === "POST") {
      const body = (await req.json()) as Record<string, string>;
      const entries: Record<string, string> = {};
      for (const [k, v] of Object.entries(body)) entries[k] = String(v);
      await sync.settings.setMany(entries);
      return json({ ok: true, settings: await sync.settings.getAll() });
    }

    // --- Connections CRUD ---
    if (subPath === "connections" && method === "GET") {
      return json({ connections: await sync.connections.list() });
    }
    if (subPath === "connections" && method === "POST") {
      const body = (await req.json()) as any;
      const id = await sync.connections.upsert({
        id: body.id ? Number(body.id) : undefined,
        telegram_channel_id: emptyToNull(body.telegram_channel_id),
        telegram_channel_username: emptyToNull(body.telegram_channel_username),
        telegram_discussion_id: emptyToNull(body.telegram_discussion_id),
        bale_channel_id: emptyToNull(body.bale_channel_id),
        bale_channel_username: emptyToNull(body.bale_channel_username),
        bale_discussion_id: emptyToNull(body.bale_discussion_id),
        is_enabled: body.is_enabled !== false,
      });
      return json({ ok: true, id, connections: await sync.connections.list() });
    }
    if (subPath.startsWith("connections/") && method === "DELETE") {
      const id = Number(subPath.split("/")[1]);
      await sync.connections.delete(id);
      return json({ ok: true, connections: await sync.connections.list() });
    }

    // --- Operational actions ---
    if (subPath === "retry" && method === "POST") {
      const n = await sync.jobs.retryFailed();
      return json({ ok: true, requeued: n });
    }
    if (subPath === "pause" && method === "POST") {
      await sync.settings.set("paused", "true");
      return json({ ok: true, paused: true });
    }
    if (subPath === "resume" && method === "POST") {
      await sync.settings.set("paused", "false");
      return json({ ok: true, paused: false });
    }

    // --- Webhook registration (uses secrets, not exposed) ---
    if (subPath === "register-webhooks" && method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { base_url?: string };
      const baseUrl = (body.base_url ?? new URL(req.url).origin).replace(/\/$/, "");
      const results = await registerWebhooks(sync, env, baseUrl);
      return json({ ok: true, results });
    }

    return json({ error: "not_found" }, 404);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

function emptyToNull(v: unknown): string | null {
  const s = v == null ? "" : String(v).trim();
  return s.length ? s : null;
}

/** Register both webhooks with their platforms using the effective secrets. */
async function registerWebhooks(sync: SyncContext, env: Env, baseUrl: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const tgSecret = sync.secrets.telegramWebhookSecret;
  const baleSecret = sync.secrets.baleWebhookSecret;

  if (!tgSecret) {
    out.telegram = { error: "TELEGRAM_WEBHOOK_SECRET is not set (dashboard or env)." };
  } else {
    try {
      out.telegram = await sync.telegram.call("setWebhook", {
        url: `${baseUrl}/webhooks/telegram/${tgSecret}`,
        secret_token: tgSecret,
        allowed_updates: ["channel_post", "edited_channel_post", "message", "edited_message"],
      });
    } catch (e) {
      out.telegram = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  if (!baleSecret) {
    out.bale = { error: "BALE_WEBHOOK_SECRET is not set (dashboard or env)." };
  } else {
    try {
      out.bale = await sync.bale.call("setWebhook", {
        url: `${baseUrl}/webhooks/bale/${baleSecret}`,
      });
    } catch (e) {
      out.bale = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return out;
}
