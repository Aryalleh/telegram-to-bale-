import type { Chat } from "../types/telegram.js";

/**
 * Build a public https://t.me/... link to a message when the chat has a public
 * username. Private channels/groups cannot be deep-linked publicly, so this
 * returns null in that case (the caller falls back to no link).
 */
export function telegramMessageLink(chat: Chat, messageId: number): string | null {
  if (chat.username) {
    return `https://t.me/${chat.username}/${messageId}`;
  }
  // Private supergroups/channels use the -100<internal> form of t.me/c/<id>/<msg>
  const id = chat.id;
  if (typeof id === "number" && String(id).startsWith("-100")) {
    const internal = String(id).slice(4);
    return `https://t.me/c/${internal}/${messageId}`;
  }
  return null;
}

/**
 * Build a link to a comment in the discussion group. Telegram threads a comment
 * under the channel post; the public form is t.me/<channel_username>/<post>?comment=<id>.
 * Falls back to the plain group message link.
 */
export function telegramCommentLink(
  discussionChat: Chat,
  channelUsername: string | null,
  channelPostId: number | null,
  commentMessageId: number,
): string | null {
  if (channelUsername && channelPostId) {
    return `https://t.me/${channelUsername}/${channelPostId}?comment=${commentMessageId}`;
  }
  return telegramMessageLink(discussionChat, commentMessageId);
}

/**
 * Build a public link to a Bale message when the chat has a username.
 * Bale public links use https://ble.ir/<username>/<message_id>.
 */
export function baleMessageLink(chat: Chat, messageId: number): string | null {
  if (chat.username) {
    return `https://ble.ir/${chat.username}/${messageId}`;
  }
  return null;
}

/**
 * Best public link to a message on its source platform: prefer a username-based
 * link (t.me/<user>/<id> or ble.ir/<user>/<id>) — using the chat's own username
 * or a caller-supplied channel username — and fall back to the private
 * (t.me/c/…) form. Returns null when no link can be built.
 */
export function bestSourceMessageLink(
  source: "telegram" | "bale",
  chat: Chat,
  messageId: number,
  channelUsername?: string | null,
): string | null {
  const uname = (chat.username ?? channelUsername ?? "").replace(/^@/, "");
  if (uname) {
    return source === "telegram"
      ? `https://t.me/${uname}/${messageId}`
      : `https://ble.ir/${uname}/${messageId}`;
  }
  return source === "telegram" ? telegramMessageLink(chat, messageId) : baleMessageLink(chat, messageId);
}

/**
 * Public, username-based link to a Telegram comment:
 *   https://t.me/<channel_username>/<postId>?comment=<commentId>
 * Returns null when the channel has no public username.
 */
export function telegramCommentUrl(
  channelUsername: string | null | undefined,
  channelPostId: string | null | undefined,
  commentId: number,
): string | null {
  const uname = (channelUsername ?? "").replace(/^@/, "");
  if (uname && channelPostId) return `https://t.me/${uname}/${channelPostId}?comment=${commentId}`;
  return null;
}

/**
 * Public, username-based link to a Bale post (where its comments live):
 *   https://ble.ir/<channel_username>/<postId>
 * Returns null when the channel has no public username.
 */
export function baleCommentUrl(
  channelUsername: string | null | undefined,
  channelPostId: string | null | undefined,
): string | null {
  const uname = (channelUsername ?? "").replace(/^@/, "");
  if (uname && channelPostId) return `https://ble.ir/${uname}/${channelPostId}`;
  return null;
}
