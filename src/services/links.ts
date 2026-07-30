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
