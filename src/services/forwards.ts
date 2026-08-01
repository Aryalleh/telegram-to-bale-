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
 * The message is (definitely) the auto-forwarded copy of *our* linked channel's
 * post: an automatic forward, or authored as / forwarded from our own channel.
 * All signals are exact matches to our channel id, so genuine comments —
 * including messages from bots, anonymous senders, or forwards from *other*
 * chats — are never mistaken for the post copy.
 */
function isStrongForward(msg: Message, channelId: string | null | undefined): boolean {
  if (msg.is_automatic_forward === true) return true;
  if (channelId == null) return false;
  const cid = String(channelId);
  if (msg.sender_chat != null && String(msg.sender_chat.id) === cid) return true;
  const fwdChat = msg.forward_from_chat ?? msg.forward_origin?.chat;
  if (fwdChat != null && String(fwdChat.id) === cid) return true;
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

  // Try to link this to a channel_post: by forward reference or content fingerprint.
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

  if (mapping) {
    // Matched a recent post (by ref or content) -> it's the auto-forwarded copy.
    await ctx.mappings.setDiscussionMessageId(mapping.id, platform, String(msg.message_id));
    return true;
  }

  if (strong) {
    // Definitely our channel's post copy but unmatched (race) — skip mirroring
    // and link it by recency, which is safe here.
    const m = await ctx.mappings.latestPostAwaitingDiscussion(platform, connection.id);
    if (m) await ctx.mappings.setDiscussionMessageId(m.id, platform, String(msg.message_id));
    return true;
  }

  // A genuine discussion message (user, bot, anonymous, or a forward from
  // elsewhere) — let it be mirrored as a comment.
  return false;
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
