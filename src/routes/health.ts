import type { Env } from "../types/env.js";
import { SyncContext } from "../services/context.js";
import { snapshot } from "../services/status.js";

/**
 * GET /health — lightweight liveness/connectivity probe.
 */
export async function handleHealth(req: Request, env: Env): Promise<Response> {
  const ctx = await SyncContext.create(env);
  const s = await snapshot(ctx);
  const ok = s.telegram !== "error" && s.bale !== "error" && s.database === "connected";
  const body = {
    status: ok ? "ok" : "degraded",
    telegram: s.telegram,
    bale: s.bale,
    database: s.database,
    sync_paused: s.sync_paused,
    pending_jobs: s.pending_jobs,
  };
  return json(body, ok ? 200 : 503);
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
