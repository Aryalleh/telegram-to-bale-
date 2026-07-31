import type { Message } from "../types/telegram.js";
import type { Platform, MessageSource } from "../types/env.js";
import type { ChannelConnection } from "../repositories/connections.js";
import type { MessageMapping } from "../repositories/message-mappings.js";
import { SyncContext } from "./context.js";
import { entitiesToMarkdown, escapeMarkdown, identityHeader, composeMirroredBody, sourceLink, quoteBlock } from "./formatter.js";
import { extractMedia, isTooLarge, transferMedia, describeSpecial } from "./media-transfer.js";
import { telegramCommentLink, baleMessageLink, telegramCommentUrl, baleCommentUrl } from "./links.js";
import { passesReplyPolicy } from "./reply-sync.js";
import { resolvePostMapping } from "./forwards.js";
import { textFingerprint } from "./hash.js";
import { enqueueDeliver } from "./job-runner.js";
import { ApiError } from "./bot-api.js";

interface DiscussionRoute {
  connection: ChannelConnection;
  destPlatform: Platform;
  destChatId: string;
}

/** Resolve the destination discussion group for a comment seen on `source`. */
export async function resolveDiscussionRoute(
  ctx: SyncContext,
  source: Platform,
  chatId: string,
): Promise<DiscussionRoute | null> {
  const conn = await ctx.connections.findByChat(chatId);
  if (!conn || !conn.is_enabled) return null;

  if (source === "telegram" && String(conn.telegram_discussion_id) === chatId) {
    if (!conn.bale_discussion_id) return null;
    return { connection: conn, destPlatform: "bale", destChatId: String(conn.bale_discussion_id) };
  }
  if (source === "bale" && String(conn.bale_discussion_id) === chatId) {
    if (!conn.telegram_discussion_id) return null;
    return { connection: conn, destPlatform: "telegram", destChatId: String(conn.telegram_discussion_id) };
  }
  return null;
}

function fromLabel(source: Platform): string {
  return source === "telegram" ? "از تلگرام" : "از بله";
}

/**
 * Identity-header signature of a message we produced as a mirror. Any incoming
 * message matching this is our own mirror echoed back by the platform and must
 * not be re-mirrored (loop prevention). Kept in sync with `identityHeader`.
 */
const MIRROR_HEADER_RE = /^\s*👤 .+ — (از تلگرام|از بله|from Telegram|from Bale)/;

function looksLikeMirror(msg: Message): boolean {
  const text = msg.text ?? msg.caption ?? "";
  return MIRROR_HEADER_RE.test(text);
}

function sourceLinkLabel(source: Platform): string {
  return source === "telegram" ? "مشاهده کامنت اصلی در تلگرام" : "مشاهده کامنت اصلی در بله";
}

function commentSource(source: Platform): MessageSource {
  return source === "telegram" ? "telegram_user" : "bale_user";
}

/**
 * Mirror a discussion-group comment/reply from `source` to the opposite
 * platform's discussion group. Handles both directions.
 */
export async function syncComment(ctx: SyncContext, source: Platform, msg: Message): Promise<void> {
  const chatId = String(msg.chat.id);

  if (!(await ctx.settings.getBool("sync_comments"))) return;
  if (await ctx.settings.getBool("paused")) return;
  if (await ctx.settings.getBool("paused_comments")) return;

  // The auto-forwarded copy of the channel post is not a user comment.
  if (msg.is_automatic_forward) return;

  // Loop prevention (primary): a message we generated as a mirror always starts
  // with our identity header ("👤 <name> — از تلگرام/بله"). Recognizing that
  // signature is timing- and platform-independent, so it stops the loop even
  // when a platform (Bale) does not set `from.is_bot` on the bot's own messages
  // and even before the outgoing mirror's id has been recorded in the mapping.
  if (looksLikeMirror(msg)) return;

  // Loop prevention (robust): compare the incoming text's fingerprint against
  // recently-created comment mirrors. A mirror's stored fingerprint includes our
  // identity header, which a genuine user message never contains — so a match
  // means this is our own mirror echoed back, even if the platform re-rendered
  // the header (different emoji/dash) so looksLikeMirror missed it.
  const incomingText = (msg.text ?? msg.caption ?? "").trim();
  if (incomingText) {
    const echoed = await ctx.mappings.recentCommentByHash(textFingerprint(incomingText));
    if (echoed) return;
  }

  // Loop prevention: bot-generated mirror already recorded on the source side.
  const existing =
    source === "telegram"
      ? await ctx.mappings.byTelegram(chatId, String(msg.message_id))
      : await ctx.mappings.byBale(chatId, String(msg.message_id));
  if (existing) return;

  // Ignore messages authored by our own bot (when the platform exposes it).
  const myBotId = await ctx.botId(source);
  if (myBotId && msg.from?.id === myBotId) return;
  if (msg.from?.is_bot) return;

  const route = await resolveDiscussionRoute(ctx, source, chatId);
  if (!route) return;

  // Resolve reply target (nested comment/reply threading).
  const { parentMapping } = await resolveParent(ctx, source, msg);

  // Apply the reply/standalone-message policy (section 8).
  if (!(await passesReplyPolicy(ctx, source, msg, parentMapping))) return;

  // Resolve which channel post this comment belongs to (top-level comments reply
  // to the auto-forwarded post copy). Used for both threading and the source link.
  const postMapping =
    !parentMapping && msg.reply_to_message
      ? await resolvePostMapping(ctx, source, msg.reply_to_message, route.connection)
      : null;

  let replyToDestId: number | undefined;
  if (parentMapping) {
    // Reply to another (already mirrored) comment -> attach to its twin.
    const destId = route.destPlatform === "bale" ? parentMapping.bale_message_id : parentMapping.telegram_message_id;
    if (destId) replyToDestId = Number(destId);
  } else if (postMapping) {
    // Top-level comment -> thread it under the post's copy in the dest group.
    const destDiscId =
      route.destPlatform === "bale" ? postMapping.bale_discussion_message_id : postMapping.telegram_discussion_message_id;
    if (destDiscId) replyToDestId = Number(destDiscId);
  }

  // Build the mirrored body.
  const includeUser = await ctx.settings.getBool("include_usernames");
  const includeProfile = await ctx.settings.getBool("include_profile_links");
  const header = identityHeader(msg, {
    includeUsername: includeUser,
    includeProfileLink: includeProfile,
    fromLabel: fromLabel(source),
  });

  const rawText = msg.text ?? msg.caption ?? "";
  const entities = msg.text ? msg.entities : msg.caption_entities;
  const special = !rawText ? describeSpecial(msg) : null;
  let body = special ? escapeMarkdown(special) : entitiesToMarkdown(rawText, entities);

  // Show a partial quote as 💬 «…» (Bale can't render partial quotes natively).
  if (msg.quote?.text?.trim()) {
    body = `${quoteBlock(msg.quote.text)}\n\n${body}`.trim();
  }

  let linkLine = "";
  if (await ctx.settings.getBool("add_source_links")) {
    // Prefer a public, username-based link to the post the comment is under
    // (t.me/<user>/<post>?comment=… or ble.ir/<user>/<post>); fall back to a
    // direct message link when the channel has no public username.
    let url: string | null = null;
    if (postMapping) {
      url =
        source === "telegram"
          ? telegramCommentUrl(route.connection.telegram_channel_username, postMapping.telegram_message_id, msg.message_id)
          : baleCommentUrl(route.connection.bale_channel_username, postMapping.bale_message_id);
    }
    if (!url) url = buildSourceLink(source, route.connection, msg);
    linkLine = sourceLink(url, sourceLinkLabel(source));
  }

  const composed = composeMirroredBody({ header, body, sourceLinkLine: linkLine || undefined });

  const mappingId = await ctx.mappings.create({
    connection_id: route.connection.id,
    message_type: parentMapping ? "reply" : "comment",
    source_platform: commentSource(source),
    // Fingerprint of exactly what we send (header included), so the mirror can be
    // recognized when it echoes back — see the loop guard above.
    content_hash: textFingerprint(composed),
    parent_mapping_id: parentMapping?.id ?? null,
    telegram_chat_id: source === "telegram" ? chatId : null,
    telegram_message_id: source === "telegram" ? String(msg.message_id) : null,
    telegram_thread_id: source === "telegram" ? (msg.message_thread_id ? String(msg.message_thread_id) : null) : null,
    bale_chat_id: source === "bale" ? chatId : null,
    bale_message_id: source === "bale" ? String(msg.message_id) : null,
  });

  try {
    const sent = await deliverComment(ctx, source, route, msg, composed, replyToDestId);
    if (route.destPlatform === "bale") {
      await ctx.mappings.setBaleSide(mappingId, route.destChatId, String(sent.message_id));
    } else {
      await ctx.mappings.setTelegramSide(mappingId, route.destChatId, String(sent.message_id), sent.message_thread_id ? String(sent.message_thread_id) : null);
    }
  } catch (err) {
    const apiErr = err instanceof ApiError ? err : null;
    await ctx.errors.record({
      platform: route.destPlatform,
      operation: "sync_comment",
      chatId: route.destChatId,
      messageId: msg.message_id,
      errorCode: apiErr?.code,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    if (!apiErr || !apiErr.permanent) {
      const transferMedia = await ctx.settings.getBool("transfer_comment_media");
      const media = transferMedia ? extractMedia(msg) : null;
      await enqueueDeliver(ctx, {
        destPlatform: route.destPlatform,
        destChatId: route.destChatId,
        kind: media ? "media" : "text",
        text: composed,
        parseMode: "Markdown",
        replyToMessageId: replyToDestId,
        mediaKind: media?.kind,
        sourcePlatform: media ? source : undefined,
        fileId: media?.fileId,
        fileName: media?.fileName,
        performer: media?.performer,
        title: media?.title,
        mappingId,
        mappingSide: route.destPlatform,
      });
    }
  }
}

/** Mirror an edit of a previously synchronized comment (text/caption only). */
export async function syncEditedComment(ctx: SyncContext, source: Platform, msg: Message): Promise<void> {
  if (!(await ctx.settings.getBool("sync_comments"))) return;
  if (await ctx.settings.getBool("paused")) return;

  const chatId = String(msg.chat.id);
  const mapping =
    source === "telegram"
      ? await ctx.mappings.byTelegram(chatId, String(msg.message_id))
      : await ctx.mappings.byBale(chatId, String(msg.message_id));
  if (!mapping) return;

  const destPlatform: Platform = source === "telegram" ? "bale" : "telegram";
  const destChatId = destPlatform === "bale" ? mapping.bale_chat_id : mapping.telegram_chat_id;
  const destMsgId = destPlatform === "bale" ? mapping.bale_message_id : mapping.telegram_message_id;
  if (!destChatId || !destMsgId) return;

  const rawText = msg.text ?? msg.caption ?? "";
  const entities = msg.text ? msg.entities : msg.caption_entities;
  const body = entitiesToMarkdown(rawText, entities);
  const header = identityHeader(msg, {
    includeUsername: await ctx.settings.getBool("include_usernames"),
    includeProfileLink: await ctx.settings.getBool("include_profile_links"),
    fromLabel: fromLabel(source),
  });
  const composed = composeMirroredBody({ header, body });

  const destApi = ctx.api(destPlatform);
  try {
    if (msg.text) {
      await destApi.editMessageText(destChatId, Number(destMsgId), composed, "Markdown");
    } else {
      await destApi.editMessageCaption(destChatId, Number(destMsgId), composed, "Markdown");
    }
  } catch (err) {
    await ctx.errors.record({
      platform: destPlatform,
      operation: "sync_edited_comment",
      chatId: destChatId,
      messageId: destMsgId,
      errorCode: err instanceof ApiError ? err.code : undefined,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Determine whether the message is a reply to another *comment* (not the
 * auto-forwarded channel post) and return that comment's mapping if known.
 */
async function resolveParent(
  ctx: SyncContext,
  source: Platform,
  msg: Message,
): Promise<{ parentMapping: MessageMapping | null; isReply: boolean }> {
  const replyTo = msg.reply_to_message;
  if (!replyTo || replyTo.is_automatic_forward) return { parentMapping: null, isReply: false };

  const parentChat = String(replyTo.chat.id);
  const parent =
    source === "telegram"
      ? await ctx.mappings.byTelegram(parentChat, String(replyTo.message_id))
      : await ctx.mappings.byBale(parentChat, String(replyTo.message_id));
  return { parentMapping: parent, isReply: true };
}

function buildSourceLink(source: Platform, conn: ChannelConnection, msg: Message): string | null {
  if (source === "telegram") {
    // Try to find the channel post id to build a ?comment= deep link is complex;
    // fall back to the discussion group message link.
    return telegramCommentLink(msg.chat, conn.telegram_channel_username, null, msg.message_id);
  }
  return baleMessageLink(msg.chat, msg.message_id);
}

/** Send a comment as text or media into the destination discussion group. */
async function deliverComment(
  ctx: SyncContext,
  source: Platform,
  route: DiscussionRoute,
  msg: Message,
  composedText: string,
  replyToDestId: number | undefined,
): Promise<Message> {
  const destApi = ctx.api(route.destPlatform);
  const sourceApi = ctx.api(source);
  const shouldTransferMedia = await ctx.settings.getBool("transfer_comment_media");
  const media = shouldTransferMedia ? extractMedia(msg) : null;

  if (media && !isTooLarge(media)) {
    try {
      // URL first, then multipart upload — makes voice / round video notes work.
      return await transferMedia(sourceApi, destApi, media, {
        chatId: route.destChatId,
        caption: composedText,
        parseMode: "Markdown",
        replyToMessageId: replyToDestId,
      });
    } catch (err) {
      if (!(err instanceof ApiError) || !err.permanent) throw err;
      // fall through to text-only with a note
    }
  }

  if (msg.location) {
    return destApi.sendLocation(route.destChatId, msg.location.latitude, msg.location.longitude, { replyToMessageId: replyToDestId });
  }
  if (msg.contact) {
    return destApi.sendContact(route.destChatId, msg.contact.phone_number, msg.contact.first_name, {
      lastName: msg.contact.last_name,
      replyToMessageId: replyToDestId,
    });
  }

  return destApi.sendMessage({
    chatId: route.destChatId,
    text: composedText || "(empty)",
    parseMode: "Markdown",
    replyToMessageId: replyToDestId,
    disableWebPagePreview: true,
  });
}
