import type { Update, Message } from "../types/telegram.js";
import type { Platform } from "../types/env.js";
import { SyncContext } from "./context.js";
import { syncChannelPost, syncEditedChannelPost } from "./post-sync.js";
import { syncComment, syncEditedComment } from "./comment-sync.js";
import { handleCommand } from "./commands.js";
import { maybeRecordForward } from "./forwards.js";
import { handleServiceMessage } from "./service-messages.js";
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

  const anyMsg = update.channel_post ?? update.edited_channel_post ?? update.message ?? update.edited_message;
  const kind = update.channel_post
    ? "channel_post"
    : update.edited_channel_post
      ? "edited_channel_post"
      : update.message
        ? "message"
        : update.edited_message
          ? "edited_message"
          : "other";
  if (anyMsg) {
    const allowed = await isChatAllowed(anyMsg.chat.id, connections, ctx.settings);
    console.log(
      `[disp] ${platform} ${kind} chat=${anyMsg.chat.id}(${anyMsg.chat.type}) msg=${anyMsg.message_id} allowed=${allowed} from=${anyMsg.from?.id ?? "-"}${anyMsg.from?.is_bot ? "(bot)" : ""} sender_chat=${anyMsg.sender_chat?.id ?? "-"} auto_fwd=${anyMsg.is_automatic_forward ?? false}`,
    );
    if (!allowed) console.log(`[disp] REJECTED not-allowlisted chat=${anyMsg.chat.id}`);
  }

  // --- Channel posts (bidirectional) ---
  if (update.channel_post) {
    const m = update.channel_post;
    if (await isChatAllowed(m.chat.id, connections, ctx.settings)) {
      if (await handleServiceMessage(ctx, platform, m, connections)) return;
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

  // --- Group / private / channel messages ---
  // Some platforms (notably Bale) deliver channel posts as `message` with
  // chat.type === "channel" rather than as `channel_post`, so we branch on the
  // chat type here instead of relying on the update key alone.
  if (update.message) {
    await routeMessage(ctx, platform, update.message, connections);
    return;
  }
  if (update.edited_message) {
    const m = update.edited_message;
    if (!(await isChatAllowed(m.chat.id, connections, ctx.settings))) return;
    if (m.chat.type === "channel") {
      await syncEditedChannelPost(ctx, platform, m);
    } else {
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

  // Service messages (member joined/left, title/pin, etc.) are never mirrored.
  // A chat-photo change is applied to the counterpart chat instead of posting.
  if (await handleServiceMessage(ctx, platform, msg, connections)) {
    console.log(`[disp] service message -> not mirrored (msg=${msg.message_id})`);
    return;
  }

  // A channel post delivered as a plain message (Bale behavior).
  if (msg.chat.type === "channel") {
    await syncChannelPost(ctx, platform, msg);
    return;
  }

  const chatId = String(msg.chat.id);
  const conn = connections.find(
    (c) =>
      String(c.telegram_discussion_id) === chatId ||
      String(c.bale_discussion_id) === chatId ||
      String(c.telegram_channel_id) === chatId ||
      String(c.bale_channel_id) === chatId,
  );

  if (!conn) {
    console.log(`[disp] no connection for discussion chat=${chatId} -> skip`);
    return;
  }

  // The auto-forwarded copy of a channel post inside the discussion group is not
  // a user comment. Record its id (for comment threading) but never mirror it.
  if (await maybeRecordForward(ctx, platform, msg, conn)) {
    console.log(`[disp] detected as post auto-forward -> recorded, not mirrored (msg=${msg.message_id})`);
    return;
  }

  // Allow admin commands issued inside the discussion group too.
  if (msg.text?.startsWith("/")) {
    const handled = await handleCommand(ctx, platform, msg);
    if (handled) return;
  }

  console.log(`[disp] -> syncComment (msg=${msg.message_id})`);
  await syncComment(ctx, platform, msg);
}
