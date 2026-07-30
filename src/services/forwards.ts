import type { Message } from "../types/telegram.js";
import type { Platform } from "../types/env.js";
import { SyncContext } from "./context.js";

/**
 * Extract the (chatId, messageId) of the *channel post* that a discussion-group
 * auto-forward copy points back to. Supports both the legacy
 * `forward_from_chat` / `forward_from_message_id` fields and the newer
 * `forward_origin`, falling back to `sender_chat`.
 */
export function forwardedPostRef(m: Message): { chatId: string; messageId: string } | null {
  const chat = m.forward_from_chat ?? m.forward_origin?.chat ?? m.sender_chat;
  const mid = m.forward_from_message_id ?? m.forward_origin?.message_id;
  if (chat && mid != null) return { chatId: String(chat.id), messageId: String(mid) };
  return null;
}

/**
 * When the auto-forwarded copy of a channel post lands in the discussion group,
 * record its message id against the channel_post mapping. This lets us later
 * reply to it so mirrored comments are threaded under the right post.
 */
export async function recordAutoForward(ctx: SyncContext, platform: Platform, msg: Message): Promise<void> {
  const ref = forwardedPostRef(msg);
  if (!ref) return;
  const mapping =
    platform === "telegram"
      ? await ctx.mappings.byTelegram(ref.chatId, ref.messageId)
      : await ctx.mappings.byBale(ref.chatId, ref.messageId);
  if (!mapping) return;
  await ctx.mappings.setDiscussionMessageId(mapping.id, platform, String(msg.message_id));
}

/**
 * Given the auto-forwarded post a top-level comment replies to, return the
 * message id to reply to in the *destination* discussion group (so the mirrored
 * comment threads under the corresponding post). Returns null if unknown.
 */
export async function resolveThreadTarget(
  ctx: SyncContext,
  source: Platform,
  autoForward: Message,
): Promise<number | null> {
  const ref = forwardedPostRef(autoForward);
  if (!ref) return null;
  const mapping =
    source === "telegram"
      ? await ctx.mappings.byTelegram(ref.chatId, ref.messageId)
      : await ctx.mappings.byBale(ref.chatId, ref.messageId);
  if (!mapping) return null;
  const destId =
    source === "telegram" ? mapping.bale_discussion_message_id : mapping.telegram_discussion_message_id;
  return destId ? Number(destId) : null;
}
