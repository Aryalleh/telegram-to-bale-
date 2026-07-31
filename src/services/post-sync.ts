import type { Message, InlineKeyboardMarkup, InlineKeyboardButton } from "../types/telegram.js";
import type { Platform, MessageSource } from "../types/env.js";
import type { ChannelConnection } from "../repositories/connections.js";
import { SyncContext } from "./context.js";
import { entitiesToMarkdown, escapeMarkdown, quoteBlock, sourceLink } from "./formatter.js";
import { extractMedia, isTooLarge, transferMedia, describeSpecial, type MediaDescriptor } from "./media-transfer.js";
import { postFingerprint } from "./hash.js";
import { telegramMessageLink, baleMessageLink } from "./links.js";
import { enqueueDeliver } from "./job-runner.js";
import { ApiError } from "./bot-api.js";

/** Which channel a post should be mirrored into, and on which platform. */
interface Route {
  connection: ChannelConnection;
  destPlatform: Platform;
  destChatId: string;
}

/**
 * Given the platform + chat id where a channel post appeared, resolve the
 * destination channel on the other platform. Returns null if the chat is not a
 * configured *channel* (e.g. it's a discussion group, handled elsewhere).
 */
export async function resolveChannelRoute(
  ctx: SyncContext,
  source: Platform,
  chatId: string,
): Promise<Route | null> {
  const conn = await ctx.connections.findByChat(chatId);
  if (!conn || !conn.is_enabled) return null;

  if (source === "telegram" && String(conn.telegram_channel_id) === chatId) {
    if (!conn.bale_channel_id) return null;
    return { connection: conn, destPlatform: "bale", destChatId: String(conn.bale_channel_id) };
  }
  if (source === "bale" && String(conn.bale_channel_id) === chatId) {
    if (!conn.telegram_channel_id) return null;
    return { connection: conn, destPlatform: "telegram", destChatId: String(conn.telegram_channel_id) };
  }
  return null;
}

function sourceLabel(source: Platform): MessageSource {
  return source === "telegram" ? "telegram_user" : "bale_user";
}

/** Convert URL inline buttons (drop callback buttons that can't work cross-platform). */
function convertButtons(markup: InlineKeyboardMarkup | undefined): InlineKeyboardMarkup | undefined {
  if (!markup?.inline_keyboard) return undefined;
  const rows: InlineKeyboardButton[][] = [];
  for (const row of markup.inline_keyboard) {
    const kept = row.filter((b) => typeof b.url === "string" && b.url.length > 0).map((b) => ({ text: b.text, url: b.url }));
    if (kept.length) rows.push(kept);
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
}

/**
 * Mirror a new channel post from `source` to the opposite platform's channel.
 * Bidirectional: works Telegram→Bale and Bale→Telegram.
 */
export async function syncChannelPost(ctx: SyncContext, source: Platform, msg: Message): Promise<void> {
  const chatId = String(msg.chat.id);

  // Feature gates
  if (!(await ctx.settings.getBool("sync_posts"))) return;
  if (await ctx.settings.getBool("paused")) return;
  if (await ctx.settings.getBool("paused_posts")) return;
  const dirKey = source === "telegram" ? "sync_telegram_to_bale" : "sync_bale_to_telegram";
  if (!(await ctx.settings.getBool(dirKey))) return;

  // Loop prevention: if this exact message is already the mirror side of a
  // mapping, it was created by our own bot — never mirror it back.
  const existingBySource =
    source === "telegram"
      ? await ctx.mappings.byTelegram(chatId, String(msg.message_id))
      : await ctx.mappings.byBale(chatId, String(msg.message_id));
  if (existingBySource) return;

  // Ignore posts authored by our own bot (best effort; channel posts are often anonymous).
  const myBotId = await ctx.botId(source);
  if (myBotId && msg.from?.id === myBotId) return;
  if (msg.from?.is_bot) return;

  // Race-proof loop guard: a mirror we just sent to `source` can echo back
  // before its destination id was recorded (byBale/byTelegram would miss it).
  // Identify it by content fingerprint and complete the pending mapping instead
  // of mirroring it again. This is what stops the Telegram<->Bale post loop when
  // a platform (Bale) doesn't mark the bot's own posts.
  const ownerConn = await ctx.connections.findByChat(chatId);
  if (ownerConn) {
    const pending =
      (await ctx.mappings.findPendingChannelMirror(ownerConn.id, source, postFingerprint(msg))) ??
      (await ctx.mappings.latestPendingChannelMirror(ownerConn.id, source));
    if (pending) {
      if (source === "bale") {
        await ctx.mappings.setBaleSide(pending.id, chatId, String(msg.message_id), msg.media_group_id ?? null);
      } else {
        await ctx.mappings.setTelegramSide(pending.id, chatId, String(msg.message_id));
      }
      return;
    }
  }

  const route = await resolveChannelRoute(ctx, source, chatId);
  if (!route) return;

  const destApi = ctx.api(route.destPlatform);
  const sourceApi = ctx.api(source);
  const silent = await ctx.settings.getBool("send_silently");

  const rawText = msg.text ?? msg.caption ?? "";
  const entities = msg.text ? msg.entities : msg.caption_entities;
  const special = !rawText ? describeSpecial(msg) : null;
  const markdown = special ? escapeMarkdown(special) : entitiesToMarkdown(rawText, entities);
  const buttons = (await ctx.settings.getBool("mirror_url_buttons")) ? convertButtons(msg.reply_markup) : undefined;

  const media = extractMedia(msg);
  const hash = postFingerprint(msg);

  // Create the mapping row first (source side known), fill dest side after send.
  const mappingId = await ctx.mappings.create({
    connection_id: route.connection.id,
    message_type: "channel_post",
    source_platform: sourceLabel(source),
    content_hash: hash,
    telegram_chat_id: source === "telegram" ? chatId : null,
    telegram_message_id: source === "telegram" ? String(msg.message_id) : null,
    telegram_media_group_id: source === "telegram" ? msg.media_group_id ?? null : null,
    bale_chat_id: source === "bale" ? chatId : null,
    bale_message_id: source === "bale" ? String(msg.message_id) : null,
    bale_media_group_id: source === "bale" ? msg.media_group_id ?? null : null,
  });

  // Preserve reply relationships: if this post replies to another channel post,
  // reply to that post's mirror on the destination side (both directions).
  const replyToDestId = await resolveChannelReplyTarget(ctx, source, route, msg);

  // If the replied-to message isn't mapped on the destination (e.g. a reply to
  // a message forwarded from another channel), we can't reply natively — so
  // quote its text under a "در پاسخ:" header, then apply any signature.
  const bodyText = await decorateBody(ctx, source, msg, markdown, replyToDestId !== undefined);

  try {
    let sent: Message;
    if (media) {
      sent = await sendMediaCrossPlatform(ctx, source, route, media, bodyText, buttons, silent, replyToDestId);
    } else {
      sent = await destApi.sendMessage({
        chatId: route.destChatId,
        text: bodyText || "(empty)",
        parseMode: "Markdown",
        replyMarkup: buttons,
        disableNotification: silent,
        replyToMessageId: replyToDestId,
      });
    }

    // Record the destination side on the mapping.
    if (route.destPlatform === "bale") {
      await ctx.mappings.setBaleSide(mappingId, route.destChatId, String(sent.message_id), sent.media_group_id ?? null);
    } else {
      await ctx.mappings.setTelegramSide(mappingId, route.destChatId, String(sent.message_id));
    }
  } catch (err) {
    await handleSendFailure(ctx, source, route, mappingId, msg, bodyText, err, replyToDestId);
  }
}

/**
 * Prepend a "forwarded from" line and a quoted block, and append the author
 * signature/hashtag, to a post body.
 */
async function decorateBody(
  ctx: SyncContext,
  source: Platform,
  msg: Message,
  markdown: string,
  replyMapped: boolean,
): Promise<string> {
  const top: string[] = [];

  // "🔁 forwarded from <channel>" (hyperlinked when the source is public).
  const fwd = forwardAttribution(source, msg);
  if (fwd) top.push(fwd);

  // Show quoted text as 💬 «…», hyperlinked to the original message. A partial
  // quote is always shown (Bale has no native partial quote); a full reply is
  // shown only when its target isn't mapped (native reply is used otherwise).
  const rt = msg.reply_to_message;
  let quoted = "";
  if (msg.quote?.text) {
    quoted = msg.quote.text;
  } else if (!replyMapped && rt && !rt.is_automatic_forward) {
    quoted = rt.text ?? rt.caption ?? "";
  }
  const qb = quoteBlock(quoted, quoteLinkFor(source, rt));
  if (qb) top.push(qb);

  let body = [...top, markdown].filter(Boolean).join("\n\n").trim();

  // Turn the post author's signature (Telegram "sign messages") into a hashtag.
  if (await ctx.settings.getBool("add_signature")) {
    const tag = hashtagify(msg.author_signature ?? "");
    if (tag) body = `${body}\n\n#${escapeMarkdown(tag)}`.trim();
  }

  // Optional fixed signature / hashtag (admin-provided, appended verbatim).
  const fixed = (await ctx.settings.get("signature_text"))?.trim();
  if (fixed) body = `${body}\n\n${fixed}`.trim();

  return body;
}

/** A public link to the replied-to message on its source platform, or null. */
function quoteLinkFor(source: Platform, replyTo: Message | undefined): string | null {
  if (!replyTo) return null;
  return source === "telegram"
    ? telegramMessageLink(replyTo.chat, replyTo.message_id)
    : baleMessageLink(replyTo.chat, replyTo.message_id);
}

/** "🔁 forwarded from <channel>" line when the message was forwarded from a channel. */
function forwardAttribution(source: Platform, msg: Message): string {
  const fwdChat = msg.forward_from_chat ?? msg.forward_origin?.chat;
  if (!fwdChat || fwdChat.type !== "channel") return "";
  const fwdMsgId = msg.forward_from_message_id ?? msg.forward_origin?.message_id;
  const title = fwdChat.title ?? fwdChat.username ?? "کانال";
  let url: string | null = null;
  if (fwdChat.username) {
    const base = source === "telegram" ? "https://t.me" : "https://ble.ir";
    url = fwdMsgId ? `${base}/${fwdChat.username}/${fwdMsgId}` : `${base}/${fwdChat.username}`;
  }
  return `🔁 ${sourceLink(url, `فوروارد شده از ${title}`) || `فوروارد شده از ${escapeMarkdown(title)}`}`;
}

/** Turn a display name into a hashtag-safe token ("Ali Rezaei" -> "Ali_Rezaei"). */
function hashtagify(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}_]/gu, "")
    .replace(/^_+|_+$/g, "");
}

/**
 * Resolve the destination reply target for a channel post that replies to
 * another channel post. Returns the mirrored message id on the destination
 * platform, or undefined if the post isn't a reply or the target isn't mapped.
 */
async function resolveChannelReplyTarget(
  ctx: SyncContext,
  source: Platform,
  route: Route,
  msg: Message,
): Promise<number | undefined> {
  const replyTo = msg.reply_to_message;
  if (!replyTo || replyTo.is_automatic_forward) return undefined;
  const chatId = String(msg.chat.id);
  const rtMapping =
    source === "telegram"
      ? await ctx.mappings.byTelegram(chatId, String(replyTo.message_id))
      : await ctx.mappings.byBale(chatId, String(replyTo.message_id));
  if (!rtMapping) return undefined;
  const destId = route.destPlatform === "bale" ? rtMapping.bale_message_id : rtMapping.telegram_message_id;
  return destId ? Number(destId) : undefined;
}

/** Attempt native media transfer; fall back per configured mode on failure. */
async function sendMediaCrossPlatform(
  ctx: SyncContext,
  source: Platform,
  route: Route,
  media: MediaDescriptor,
  caption: string,
  buttons: InlineKeyboardMarkup | undefined,
  silent: boolean,
  replyToMessageId?: number,
): Promise<Message> {
  const destApi = ctx.api(route.destPlatform);
  const sourceApi = ctx.api(source);

  if (isTooLarge(media)) {
    return sendMediaFallback(ctx, source, route, caption, "File exceeds the transfer limit.");
  }

  const transferOpts = {
    chatId: route.destChatId,
    caption: caption || undefined,
    parseMode: "Markdown" as const,
    replyMarkup: buttons,
    disableNotification: silent,
    replyToMessageId,
  };

  try {
    // transferMedia tries the URL first, then a multipart upload of the bytes
    // (which is what makes voice / round video notes work when the destination
    // won't fetch those types by URL).
    return await transferMedia(sourceApi, destApi, media, transferOpts);
  } catch (err) {
    if (err instanceof ApiError && err.permanent) {
      const mode = await ctx.settings.get("media_fallback_mode");
      if (mode === "document" && media.kind !== "document") {
        // Retry as a plain document (URL, then upload).
        return transferMedia(sourceApi, destApi, { ...media, kind: "document" }, transferOpts);
      }
      return sendMediaFallback(ctx, source, route, caption, "Media type unsupported on destination.");
    }
    throw err;
  }
}

/** Publish caption + a link back to the original, marking media unavailable. */
async function sendMediaFallback(
  ctx: SyncContext,
  source: Platform,
  route: Route,
  caption: string,
  reason: string,
): Promise<Message> {
  const destApi = ctx.api(route.destPlatform);
  const note = (await ctx.settings.get("unsupported_content_message")) ?? "Media unavailable.";
  const text = [caption, "", `⚠️ ${note}`].filter(Boolean).join("\n");
  await ctx.errors.record({ platform: route.destPlatform, operation: "media_transfer", errorMessage: reason });
  return destApi.sendMessage({ chatId: route.destChatId, text: text || note, parseMode: "Markdown" });
}

async function handleSendFailure(
  ctx: SyncContext,
  source: Platform,
  route: Route,
  mappingId: number,
  msg: Message,
  markdown: string,
  err: unknown,
  replyToMessageId?: number,
): Promise<void> {
  const apiErr = err instanceof ApiError ? err : null;
  await ctx.errors.record({
    platform: route.destPlatform,
    operation: "sync_channel_post",
    chatId: route.destChatId,
    messageId: msg.message_id,
    errorCode: apiErr?.code,
    errorMessage: err instanceof Error ? err.message : String(err),
    payloadSummary: markdown.slice(0, 200),
  });

  if (!apiErr || !apiErr.permanent) {
    // Enqueue a durable, self-contained retry.
    const media = extractMedia(msg);
    await enqueueDeliver(ctx, {
      destPlatform: route.destPlatform,
      destChatId: route.destChatId,
      kind: media ? "media" : "text",
      text: markdown || undefined,
      parseMode: "Markdown",
      replyToMessageId,
      mediaKind: media?.kind,
      sourcePlatform: media ? source : undefined,
      fileId: media?.fileId,
      fileName: media?.fileName,
      performer: media?.performer,
      title: media?.title,
      mappingId,
      mappingSide: route.destPlatform,
    });
  } else {
    await ctx.mappings.setStatus(mappingId, "outdated");
    await ctx.notifyAdmin(`❌ Failed to mirror ${source} post ${msg.message_id}: ${apiErr.message}`);
  }
}

/**
 * Mirror an edit of a channel post. Finds the twin and edits text/caption.
 * Media replacement is not editable in place — falls back to a notice.
 */
export async function syncEditedChannelPost(ctx: SyncContext, source: Platform, msg: Message): Promise<void> {
  if (!(await ctx.settings.getBool("sync_posts"))) return;
  if (await ctx.settings.getBool("paused")) return;

  const chatId = String(msg.chat.id);
  const mapping =
    source === "telegram"
      ? await ctx.mappings.byTelegram(chatId, String(msg.message_id))
      : await ctx.mappings.byBale(chatId, String(msg.message_id));
  if (!mapping) return; // never mirrored; nothing to edit

  const destPlatform: Platform = source === "telegram" ? "bale" : "telegram";
  const destChatId = destPlatform === "bale" ? mapping.bale_chat_id : mapping.telegram_chat_id;
  const destMsgId = destPlatform === "bale" ? mapping.bale_message_id : mapping.telegram_message_id;
  if (!destChatId || !destMsgId) return;

  const rawText = msg.text ?? msg.caption ?? "";
  const entities = msg.text ? msg.entities : msg.caption_entities;
  const markdown = entitiesToMarkdown(rawText, entities);
  const newHash = postFingerprint(msg);
  if (mapping.content_hash === newHash) return; // no meaningful change

  const destApi = ctx.api(destPlatform);
  const isCaption = !msg.text && !!msg.caption;
  try {
    if (isCaption) {
      await destApi.editMessageCaption(destChatId, Number(destMsgId), markdown, "Markdown");
    } else {
      await destApi.editMessageText(destChatId, Number(destMsgId), markdown || "(empty)", "Markdown");
    }
    await ctx.mappings.setContentHash(mapping.id, newHash);
  } catch (err) {
    await ctx.errors.record({
      platform: destPlatform,
      operation: "sync_edit",
      chatId: destChatId,
      messageId: destMsgId,
      errorCode: err instanceof ApiError ? err.code : undefined,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    await ctx.notifyAdmin(`⚠️ Could not edit mirrored post (mapping ${mapping.id}). Media replacement may require a manual repost.`);
  }
}

export { telegramMessageLink, baleMessageLink };
