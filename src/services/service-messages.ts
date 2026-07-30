import type { Message } from "../types/telegram.js";
import type { Platform } from "../types/env.js";
import type { ChannelConnection } from "../repositories/connections.js";
import { SyncContext } from "./context.js";
import { resolveSourceUrl, MAX_TRANSFER_BYTES } from "./media-transfer.js";

/**
 * Service messages are chat events (members joining/leaving, title changes,
 * pins, etc.), not user content. They must never be mirrored as posts or
 * comments. The one exception acted upon is a chat-photo change, which is
 * applied to the counterpart chat directly instead of posting a message.
 */
export function isServiceMessage(msg: Message): boolean {
  return !!(
    msg.new_chat_members ||
    msg.left_chat_member ||
    msg.new_chat_title ||
    msg.new_chat_photo ||
    msg.delete_chat_photo ||
    msg.pinned_message ||
    msg.group_chat_created ||
    msg.supergroup_chat_created ||
    msg.channel_chat_created ||
    msg.message_auto_delete_timer_changed
  );
}

interface Counterpart {
  destPlatform: Platform;
  destChatId: string;
}

/** Map a chat (channel or discussion group) to its counterpart on the other platform. */
function counterpartChat(conn: ChannelConnection, source: Platform, chatId: string): Counterpart | null {
  if (source === "telegram") {
    if (chatId === String(conn.telegram_channel_id) && conn.bale_channel_id)
      return { destPlatform: "bale", destChatId: String(conn.bale_channel_id) };
    if (chatId === String(conn.telegram_discussion_id) && conn.bale_discussion_id)
      return { destPlatform: "bale", destChatId: String(conn.bale_discussion_id) };
  } else {
    if (chatId === String(conn.bale_channel_id) && conn.telegram_channel_id)
      return { destPlatform: "telegram", destChatId: String(conn.telegram_channel_id) };
    if (chatId === String(conn.bale_discussion_id) && conn.telegram_discussion_id)
      return { destPlatform: "telegram", destChatId: String(conn.telegram_discussion_id) };
  }
  return null;
}

/**
 * Handle a service message. Returns true if the message was a service message
 * (so the caller stops and does not mirror it). Chat-photo changes are applied
 * to the counterpart chat; all other service events are simply ignored.
 */
export async function handleServiceMessage(
  ctx: SyncContext,
  source: Platform,
  msg: Message,
  connections: ChannelConnection[],
): Promise<boolean> {
  if (!isServiceMessage(msg)) return false;

  const chatId = String(msg.chat.id);
  const conn = connections.find(
    (c) =>
      chatId === String(c.telegram_channel_id) ||
      chatId === String(c.telegram_discussion_id) ||
      chatId === String(c.bale_channel_id) ||
      chatId === String(c.bale_discussion_id),
  );

  if (conn && (msg.new_chat_photo?.length || msg.delete_chat_photo)) {
    const dest = counterpartChat(conn, source, chatId);
    if (dest) await applyChatPhoto(ctx, source, msg, dest);
  }

  // Every service message is consumed here (never mirrored as content).
  return true;
}

async function applyChatPhoto(ctx: SyncContext, source: Platform, msg: Message, dest: Counterpart): Promise<void> {
  const destApi = ctx.api(dest.destPlatform);
  try {
    if (msg.delete_chat_photo) {
      await destApi.deleteChatPhoto(dest.destChatId);
      return;
    }
    const photos = msg.new_chat_photo!;
    const best = photos[photos.length - 1]; // highest resolution
    const url = await resolveSourceUrl(ctx.api(source), best.file_id);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`photo download failed: ${resp.status}`);
    const bytes = await resp.arrayBuffer();
    if (bytes.byteLength > MAX_TRANSFER_BYTES) throw new Error("photo too large");
    await destApi.setChatPhoto(dest.destChatId, bytes);
  } catch (err) {
    await ctx.errors.record({
      platform: dest.destPlatform,
      operation: "set_chat_photo",
      chatId: dest.destChatId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}
