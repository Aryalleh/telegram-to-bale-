import type { Message, MessageEntity, User, Chat } from "../types/telegram.js";

/**
 * Escape characters that are significant in Bale/Telegram legacy Markdown so
 * user text can be embedded safely without breaking formatting or injecting
 * unintended links/mentions.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_\[\]])/g, "\\$1");
}

/** Escape text that appears inside a [label](url) — only ] needs care in label. */
function escapeLinkLabel(text: string): string {
  return text.replace(/([\[\]])/g, "\\$1").replace(/\n/g, " ");
}

/**
 * Convert a Telegram message's text/caption + entities into Markdown that Bale
 * (and Telegram) render with the legacy `Markdown` parse mode.
 *
 * This walks the UTF-16 code units the way Telegram entity offsets are defined.
 */
export function entitiesToMarkdown(text: string, entities: MessageEntity[] | undefined): string {
  if (!entities || entities.length === 0) return escapeMarkdown(text);

  // Telegram offsets are in UTF-16 code units.
  const units = Array.from({ length: text.length }, (_, i) => text[i]);

  // Build a list of (open, close) insertions per entity, sorted so that we can
  // wrap ranges. We render by slicing the string at boundaries.
  const sorted = [...entities].sort((a, b) => a.offset - b.offset || b.length - a.length);

  let result = "";
  let cursor = 0;

  const renderPlain = (from: number, to: number) => {
    const slice = units.slice(from, to).join("");
    return escapeMarkdown(slice);
  };

  // Simple non-overlapping renderer: handle top-level entities in order and
  // ignore nested ones (rare in channel posts) by skipping entities inside an
  // already-consumed range.
  for (const e of sorted) {
    if (e.offset < cursor) continue; // nested/overlapping — skip
    if (e.offset > cursor) result += renderPlain(cursor, e.offset);

    const raw = units.slice(e.offset, e.offset + e.length).join("");
    result += wrapEntity(e, raw);
    cursor = e.offset + e.length;
  }
  if (cursor < units.length) result += renderPlain(cursor, units.length);
  return result;
}

function wrapEntity(e: MessageEntity, raw: string): string {
  const safe = escapeMarkdown(raw);
  switch (e.type) {
    case "bold":
      return `*${safe}*`;
    case "italic":
      return `_${safe}_`;
    case "underline":
      // Bale/legacy Markdown has no underline — fall back to italic.
      return `_${safe}_`;
    case "strikethrough":
      // No strikethrough in legacy Markdown — wrap in tildes as a best effort.
      return `~${safe}~`;
    case "code":
      return `\`${raw}\``;
    case "pre":
      return `\n\`\`\`${e.language ?? ""}\n${raw}\n\`\`\`\n`;
    case "blockquote":
      return raw
        .split("\n")
        .map((l) => `> ${escapeMarkdown(l)}`)
        .join("\n");
    case "text_link":
      return `[${escapeLinkLabel(raw)}](${e.url ?? ""})`;
    case "text_mention":
      return e.user?.id ? `[${escapeLinkLabel(raw)}](tg://user?id=${e.user.id})` : safe;
    case "url":
    case "mention":
    case "hashtag":
    case "cashtag":
    case "bot_command":
    case "email":
    case "phone_number":
    default:
      // Leave these effectively as-is (escaped) — they render as plain text or
      // auto-links on the destination.
      return safe;
  }
}

/** Human display name for a Telegram/Bale user. */
export function displayName(user?: User, senderChat?: Chat): string {
  if (senderChat) return senderChat.title ?? senderChat.username ?? "Channel";
  if (!user) return "Unknown";
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return name || user.username || `User ${user.id}`;
}

export interface IdentityOptions {
  includeUsername: boolean;
  includeProfileLink: boolean;
  fromLabel: string; // e.g. "from Telegram" / "from Bale"
}

/**
 * Build the identity header line that prefixes a mirrored comment/reply, e.g.
 *   👤 Ali Rezaei (@ali) — from Telegram
 */
export function identityHeader(msg: Message, opts: IdentityOptions): string {
  const name = displayName(msg.from, msg.sender_chat);
  let who = escapeMarkdown(name);

  if (opts.includeUsername && msg.from?.username) {
    who += ` (@${msg.from.username})`;
  }
  return `👤 ${who} — ${escapeMarkdown(opts.fromLabel)}`;
}

/**
 * Render quoted text as: 💬 «quoted text». When a url is given the guillemet
 * text becomes a hyperlink to the original quoted message. Uses guillemets and
 * an emoji so it renders regardless of Markdown blockquote support.
 */
export function quoteBlock(text: string, url?: string | null): string {
  const t = text.trim();
  if (!t) return "";
  if (url) {
    return `💬 [«${escapeLinkLabel(t)}»](${url})`;
  }
  return `💬 «${escapeMarkdown(t)}»`;
}

/** Build a hyperlink line, or empty string if url is missing. */
export function sourceLink(url: string | null, label: string): string {
  if (!url) return "";
  return `[${escapeLinkLabel(label)}](${url})`;
}

/**
 * "🔁 فوروارد شده از <source>" line for a forwarded message. Covers forwards
 * from a channel (hyperlinked when public), a group, a user or bot, and a
 * privacy-hidden user. Returns "" when the message isn't a forward.
 */
export function forwardAttribution(platform: "telegram" | "bale", msg: Message): string {
  const origin = msg.forward_origin;
  let name: string | null = null;
  let url: string | null = null;

  const channelChat = (msg.forward_from_chat?.type === "channel" && msg.forward_from_chat) ||
    (origin?.chat?.type === "channel" && origin?.chat) || null;

  if (channelChat) {
    name = channelChat.title ?? channelChat.username ?? "کانال";
    const msgId = msg.forward_from_message_id ?? origin?.message_id;
    if (channelChat.username) {
      const base = platform === "telegram" ? "https://t.me" : "https://ble.ir";
      url = msgId ? `${base}/${channelChat.username}/${msgId}` : `${base}/${channelChat.username}`;
    }
  } else if (msg.forward_from_chat) {
    name = msg.forward_from_chat.title ?? msg.forward_from_chat.username ?? "چت";
  } else if (origin?.sender_chat) {
    name = origin.sender_chat.title ?? origin.sender_chat.username ?? "چت";
  } else if (msg.forward_from) {
    name = displayName(msg.forward_from);
  } else if (origin?.sender_user) {
    name = displayName(origin.sender_user);
  } else if (msg.forward_sender_name) {
    name = msg.forward_sender_name;
  } else if (origin?.sender_user_name) {
    name = origin.sender_user_name;
  }

  if (!name) return "";
  const inner = url ? sourceLink(url, `فوروارد شده از ${name}`) : `فوروارد شده از ${escapeMarkdown(name)}`;
  return `🔁 ${inner}`;
}

/**
 * Compose the full mirrored comment/reply body:
 *   👤 Name — from X
 *
 *   <body>
 *
 *   <source link>
 */
export function composeMirroredBody(parts: {
  header: string;
  body: string;
  sourceLinkLine?: string;
}): string {
  const chunks = [parts.header, "", parts.body];
  if (parts.sourceLinkLine) {
    chunks.push("", parts.sourceLinkLine);
  }
  return chunks.join("\n").trim();
}
