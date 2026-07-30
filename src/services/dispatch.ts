import type { Update, Message } from "../types/telegram.js";
import type { Platform } from "../types/env.js";
import { SyncContext } from "./context.js";
import { syncChannelPost, syncEditedChannelPost } from "./post-sync.js";
import { syncComment, syncEditedComment } from "./comment-sync.js";
import { handleCommand } from "./commands.js";
import { isChatAllowed } from "../security/allowlists.js";

/**
 * Route a single incoming update from `platform` to the correct sync handler.
 * Idempotency is enforced here via the processed_updates claim.
 */
export async function dispatchUpdate(ctx: SyncContext, platform: Platform, update: Update): Promise<void> {
  // Idempotency: claim the update id; skip if already handled (duplicate delivery).
  const claimed = await ctx.processed.claim(platform, update.update_id);
  if (!claimed) return;

  try {
    await routeUpdate(ctx, platform, update);
    await ctx.processed.markProcessed(platform, update.update_id, "processed");
  } catch (err) {
    // Release the claim so a retried webhook delivery can be reprocessed.
    await ctx.processed.release(platform, update.update_id);
    await ctx.errors.record({
      platform,
      operation: "dispatch",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function routeUpdate(ctx: SyncContext, platform: Platform, update: Update): Promise<void> {
  const connections = await ctx.connections.getEnabled();

  // --- Channel posts (bidirectional) ---
  if (update.channel_post) {
    const m = update.channel_post;
    if (await isChatAllowed(m.chat.id, connections, ctx.settings)) {
      await syncChannelPost(ctx, platform, m);
    }
    return;
  }
  if (update.edited_channel_post) {
    const m = update.edited_channel_post;
    if (await isChatAllowed(m.chat.id, connections, ctx.settings)) {
      await syncEditedChannelPost(ctx, platform, m);
    }
    return;
  }

  // --- Group / private messages ---
  if (update.message) {
    await routeMessage(ctx, platform, update.message, connections);
    return;
  }
  if (update.edited_message) {
    const m = update.edited_message;
    if (await isChatAllowed(m.chat.id, connections, ctx.settings)) {
      await syncEditedComment(ctx, platform, m);
    }
    return;
  }
}

async function routeMessage(
  ctx: SyncContext,
  platform: Platform,
  msg: Message,
  connections: Awaited<ReturnType<SyncContext["connections"]["getEnabled"]>>,
): Promise<void> {
  // Private chats: only admin commands are meaningful.
  if (msg.chat.type === "private") {
    await handleCommand(ctx, platform, msg);
    return;
  }

  const allowed = await isChatAllowed(msg.chat.id, connections, ctx.settings);
  if (!allowed) return;

  // Allow admin commands issued inside the discussion group too.
  if (msg.text?.startsWith("/")) {
    const handled = await handleCommand(ctx, platform, msg);
    if (handled) return;
  }

  await syncComment(ctx, platform, msg);
}
