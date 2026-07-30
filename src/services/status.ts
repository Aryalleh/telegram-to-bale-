import { SyncContext } from "./context.js";

function todayIso(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} 00:00:00`;
}

export interface StatusSnapshot {
  telegram: string;
  bale: string;
  database: string;
  sync_paused: boolean;
  pending_jobs: number;
  recent_errors: number;
}

/** Gather a live status snapshot (used by /health, /status and the dashboard). */
export async function snapshot(ctx: SyncContext): Promise<StatusSnapshot> {
  let telegram = "unknown";
  let bale = "unknown";
  let database = "unknown";

  try {
    await ctx.telegram.getMe();
    telegram = "connected";
  } catch {
    telegram = "error";
  }
  try {
    await ctx.bale.getMe();
    bale = "connected";
  } catch {
    bale = "error";
  }
  try {
    await ctx.env.DB.prepare("SELECT 1").first();
    database = "connected";
  } catch {
    database = "error";
  }

  return {
    telegram,
    bale,
    database,
    sync_paused: await ctx.settings.getBool("paused"),
    pending_jobs: await ctx.jobs.countPending(),
    recent_errors: await ctx.errors.countSince(todayIso()),
  };
}

export async function buildStatus(ctx: SyncContext): Promise<string> {
  const s = await snapshot(ctx);
  const recentPost = (await ctx.mappings.recent(1)).find((m) => m.message_type === "channel_post");
  return [
    "*Synchronization status*",
    `• Telegram: ${s.telegram}`,
    `• Bale: ${s.bale}`,
    `• Database: ${s.database}`,
    `• Paused: ${s.sync_paused ? "yes" : "no"}`,
    `• Pending jobs: ${s.pending_jobs}`,
    `• Errors today: ${s.recent_errors}`,
    recentPost ? `• Last post mapping: #${recentPost.id}` : "• Last post: none",
  ].join("\n");
}

export async function buildStats(ctx: SyncContext): Promise<string> {
  const since = todayIso();
  const posts = await ctx.mappings.countByType("channel_post", since);
  const comments = await ctx.mappings.countByType("comment", since);
  const replies = await ctx.mappings.countByType("reply", since);
  const pending = await ctx.jobs.countPending();
  const errors = await ctx.errors.countSince(since);
  return [
    "*Statistics (today, UTC)*",
    `• Posts synchronized: ${posts}`,
    `• Comments synchronized: ${comments}`,
    `• Replies synchronized: ${replies}`,
    `• Pending jobs: ${pending}`,
    `• Errors: ${errors}`,
  ].join("\n");
}
