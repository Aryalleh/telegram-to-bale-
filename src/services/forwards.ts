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

/**
 * Strong signal: the message is definitely the auto-forwarded copy of *our*
 * linked channel's post (safe to link by recency).
 */
function isStrongForward(msg: Message, channelId: string | null | undefined): boolean {
  if (msg.is_automatic_forward === true) return true;
  if (msg.sender_chat != null && channelId != null && String(msg.sender_chat.id) === String(channelId)) return true;
  return false;
}

/**
 * Weak signal: the message is authored *as a channel* or forwarded *from a
 * channel*. This still means "not a genuine user comment" (so don't mirror it),
 * but the origin may be another channel — e.g. the auto-forwarded copy of a
 * message that was itself forwarded — so we only link it to a mapping on a
 * confident (content) match, never by recency.
 */
function isWeakForward(msg: Message): boolean {
  if (msg.sender_chat != null && msg.sender_chat.type === "channel") return true;
  const fwdChat = msg.forward_from_chat ?? msg.forward_origin?.chat;
  if (fwdChat != null && fwdChat.type === "channel") return true;
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
  const strong = isStrongForward(msg, channelId);
  const weak = strong || isWeakForward(msg);

  // A confident link: by forward reference, or by content fingerprint.
  const ref = forwardedPostRef(msg);
  let mapping =
    ref
      ? platform === "telegram"
        ? await ctx.mappings.byTelegram(ref.chatId, ref.messageId)
        : await ctx.mappings.byBale(ref.chatId, ref.messageId)
      : null;
  if (!mapping) {
    mapping = await ctx.mappings.recentPostByHashMissingDiscussion(connection.id, platform, postFingerprint(msg));
  }

  if (!strong && !weak) {
    // No forward signal at all: it's a real comment unless the content matches
    // a recent post (mapping found above).
    if (!mapping) return false;
  }

  // Strong-only: allow the recency fallback (safe, it's definitely our channel).
  if (!mapping && strong) {
    mapping = await ctx.mappings.latestPostAwaitingDiscussion(platform, connection.id);
  }

  if (mapping) {
    await ctx.mappings.setDiscussionMessageId(mapping.id, platform, String(msg.message_id));
  }
  // Anything with a forward signal is never mirrored as a comment.
  return true;
}

/**
 * Resolve the channel_post mapping a top-level comment belongs to, from the
 * auto-forwarded post copy it replies to — by forward reference, or as a
 * fallback by content fingerprint. Returns null if unknown.
 */
export async function resolvePostMapping(
  ctx: SyncContext,
  source: Platform,
  autoForward: Message,
  connection?: ChannelConnection | null,
) {
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
  return mapping;
}
