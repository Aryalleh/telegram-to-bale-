import type { Env } from "./types/env.js";
import { handleTelegramWebhook } from "./routes/telegram-webhook.js";
import { handleBaleWebhook } from "./routes/bale-webhook.js";
import { handleHealth } from "./routes/health.js";
import { handleAdmin } from "./routes/admin.js";
import { SyncContext } from "./services/context.js";
import { processDueJobs } from "./services/job-runner.js";

/**
 * Cloudflare Worker entry point. Routes:
 *   GET  /                              -> redirect to dashboard
 *   GET  /dashboard                     -> admin dashboard (static asset)
 *   GET  /health                        -> health probe
 *   POST /webhooks/telegram/{secret}    -> Telegram webhook
 *   POST /webhooks/bale/{secret}        -> Bale webhook
 *   *    /admin/*                       -> admin JSON API (Bearer auth)
 */
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      // Serve the dashboard directly (no redirect) for both "/" and "/dashboard".
      // We fetch the asset by its exact filename; html_handling is disabled in
      // wrangler.jsonc so the ASSETS service returns the file itself (200)
      // instead of redirecting "/dashboard.html" -> "/dashboard" (which would
      // otherwise cause an infinite redirect loop).
      if (path === "/" || path === "/dashboard") {
        return env.ASSETS.fetch(new Request(url.origin + "/dashboard.html", { method: "GET" }));
      }

      if (path === "/health") {
        return handleHealth(req, env);
      }

      // /webhooks/telegram/{secret}
      const tg = path.match(/^\/webhooks\/telegram\/(.+)$/);
      if (tg) return handleTelegramWebhook(req, env, ctx, tg[1]);

      // /webhooks/bale/{secret}
      const bale = path.match(/^\/webhooks\/bale\/(.+)$/);
      if (bale) return handleBaleWebhook(req, env, ctx, bale[1]);

      // /admin/<subpath>
      const admin = path.match(/^\/admin\/(.+)$/);
      if (admin) return handleAdmin(req, env, ctx, admin[1]);
      if (path === "/admin") return handleAdmin(req, env, ctx, "status");

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      console.error("unhandled error", err);
      return new Response("Internal Server Error", { status: 500 });
    }
  },

  /**
   * Scheduled (cron) handler: drains the durable retry queue. Configure a
   * trigger in wrangler.jsonc (e.g. every minute) to enable it.
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const sync = await SyncContext.create(env);
    ctx.waitUntil(processDueJobs(sync, 20).then(() => undefined).catch((e) => console.error("job runner error", e)));
  },
};
