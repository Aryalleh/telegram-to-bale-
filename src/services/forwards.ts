import type { Message } from "../types/telegram.js";
import type { Platform } from "../types/env.js";
import type { ChannelConnection } from "../repositories/connections.js";
import { SyncContext } from "./context.js";
import { postFingerprint } from "./hash.js";

/**
 * Extract the (chatId, messageId) of the *channel post* that a discussion-group
 * auto-forward copy points back to. Supports the legacy
 * `forward_from_chat` / `forward_from_message_id` fields and the newer
 * `forward_origin`, falling back to `sender_chat`.
 */
export function forwardedPostRef(m: Message): { chatId: string; messageId: string } | null {
  const chat = m.forward_from_chat ?? m.forward_origin?.chat ?? m.sender_chat;
  const mid = m.forward_from_message_id ?? m.forward_origin?.message_id;
  if (chat && mid != null) return { chatId: String(chat.id), messageId: String(mid) };
  return null;
}

/** Is this discussion-group message the auto-forwarded copy of a channel post? */
function isFlaggedForward(msg: Message, channelId: string | null | undefined): boolean {
  if (msg.is_automatic_forward === true) return true;
  if (msg.sender_chat != null && channelId != null && String(msg.sender_chat.id) === String(channelId)) return true;
  return false;
}

/**
 * If `msg` is the auto-forwarded copy of a channel post, record its discussion
 * message id against the channel_post mapping (so mirrored comments can be
 * threaded under the post) and return true. Returns false for genuine comments.
 *
 * Detection order:
 *  1. Platform flags: is_automatic_forward, or sender_chat == linked channel.
 *  2. Content fingerprint: matches a recent post from this connection whose
 *     discussion id is still missing (covers platforms that omit the flags).
 */
export async function maybeRecordForward(
  ctx: SyncContext,
  platform: Platform,
  msg: Message,
  connection: ChannelConnection,
): Promise<boolean> {
  const channelId = platform === "telegram" ? connection.telegram_channel_id : connection.bale_channel_id;
  const flagged = isFlaggedForward(msg, channelId);

  let mapping = null;
  if (flagged) {
    const ref = forwardedPostRef(msg);
    if (ref) {
      mapping =
        platform === "telegram"
          ? await ctx.mappings.byTelegram(ref.chatId, ref.messageId)
          : await ctx.mappings.byBale(ref.chatId, ref.messageId);
    }
    if (!mapping) {
      mapping =
        (await ctx.mappings.recentPostByHashMissingDiscussion(connection.id, platform, postFingerprint(msg))) ??
        (await ctx.mappings.latestPostAwaitingDiscussion(platform, connection.id));
    }
  } else {
    // Not flagged: only treat as a forward if the content matches a recent post
    // still missing its discussion id. Otherwise it's a real comment.
    mapping = await ctx.mappings.recentPostByHashMissingDiscussion(connection.id, platform, postFingerprint(msg));
    if (!mapping) return false;
  }

  if (mapping) {
    await ctx.mappings.setDiscussionMessageId(mapping.id, platform, String(msg.message_id));
  }
  // Flagged messages are never mirrored as comments, even if we couldn't map them.
  return true;
}

/**
 * Given the auto-forwarded post a top-level comment replies to, return the
 * message id to reply to in the *destination* discussion group (so the mirrored
 * comment threads under the corresponding post). Falls back to matching the
 * post by content fingerprint. Returns null if unknown.
 */
export async function resolveThreadTarget(
  ctx: SyncContext,
  source: Platform,
  autoForward: Message,
  connection?: ChannelConnection | null,
): Promise<number | null> {
  const ref = forwardedPostRef(autoForward);
  let mapping = null;
  if (ref) {
    mapping =
      source === "telegram"
        ? await ctx.mappings.byTelegram(ref.chatId, ref.messageId)
        : await ctx.mappings.byBale(ref.chatId, ref.messageId);
  }
  if (!mapping && connection) {
    mapping = await ctx.mappings.channelPostByHash(connection.id, postFingerprint(autoForward));
  }
  if (!mapping) return null;
  const destId =
    source === "telegram" ? mapping.bale_discussion_message_id : mapping.telegram_discussion_message_id;
  return destId ? Number(destId) : null;
}
