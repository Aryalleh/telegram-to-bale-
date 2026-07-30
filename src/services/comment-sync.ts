import type { Message } from "../types/telegram.js";
import type { Platform, MessageSource } from "../types/env.js";
import type { ChannelConnection } from "../repositories/connections.js";
import type { MessageMapping } from "../repositories/message-mappings.js";
import { SyncContext } from "./context.js";
import { entitiesToMarkdown, identityHeader, composeMirroredBody, sourceLink } from "./formatter.js";
import { extractMedia, resolveSourceUrl, isTooLarge } from "./media-transfer.js";
import { telegramCommentLink, baleMessageLink } from "./links.js";
import { passesReplyPolicy } from "./reply-sync.js";
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
  return source === "telegram" ? "from Telegram" : "from Bale";
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

  // Loop prevention: bot-generated mirror already recorded on the source side.
  const existing =
    source === "telegram"
      ? await ctx.mappings.byTelegram(chatId, String(msg.message_id))
      : await ctx.mappings.byBale(chatId, String(msg.message_id));
  if (existing) return;

  // Ignore messages authored by our own bot.
  const myBotId = await ctx.botId(source);
  if (msg.from?.is_bot && myBotId && msg.from.id === myBotId) return;
  // Ignore any bot author to avoid mirroring other bots' service messages.
  if (msg.from?.is_bot) return;

  const route = await resolveDiscussionRoute(ctx, source, chatId);
  if (!route) return;

  // Resolve reply target (nested comment/reply threading).
  const { parentMapping, isReply } = await resolveParent(ctx, source, msg);

  // Apply the reply/standalone-message policy (section 8).
  if (!(await passesReplyPolicy(ctx, source, msg, parentMapping))) return;

  let replyToDestId: number | undefined;
  if (parentMapping) {
    const destId = route.destPlatform === "bale" ? parentMapping.bale_message_id : parentMapping.telegram_message_id;
    if (destId) replyToDestId = Number(destId);
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
  const body = entitiesToMarkdown(rawText, entities);

  let linkLine = "";
  if (await ctx.settings.getBool("add_source_links")) {
    const url = buildSourceLink(source, route.connection, msg);
    linkLine = sourceLink(url, source === "telegram" ? "View the original comment on Telegram" : "View the original comment on Bale");
  }

  const composed = composeMirroredBody({ header, body, sourceLinkLine: linkLine || undefined });

  const mappingId = await ctx.mappings.create({
    connection_id: route.connection.id,
    message_type: isReply ? "reply" : "comment",
    source_platform: commentSource(source),
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
  const transferMedia = await ctx.settings.getBool("transfer_comment_media");
  const media = transferMedia ? extractMedia(msg) : null;

  if (media && !isTooLarge(media)) {
    try {
      const url = await resolveSourceUrl(sourceApi, media.fileId);
      return await destApi.sendMedia(media.kind, {
        chatId: route.destChatId,
        media: url,
        caption: composedText,
        parseMode: "Markdown",
        replyToMessageId: replyToDestId,
        fileName: media.fileName,
        performer: media.performer,
        title: media.title,
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
