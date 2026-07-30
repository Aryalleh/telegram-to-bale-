import type { Platform } from "../types/env.js";
import { SyncContext } from "./context.js";
import { transferMedia, type MediaKind } from "./media-transfer.js";
import { backoffSeconds, isRetryable } from "./retry.js";
import { ApiError } from "./bot-api.js";

/**
 * Self-contained delivery job. Stores everything needed to (re)send a message
 * on the destination platform, so a retry never depends on re-fetching the
 * original webhook payload.
 */
export interface DeliverPayload {
  destPlatform: Platform;
  destChatId: string;
  kind: "text" | "media" | "location" | "contact";
  text?: string;
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  replyToMessageId?: number;
  messageThreadId?: number;
  disableNotification?: boolean;

  // media
  mediaKind?: MediaKind;
  sourcePlatform?: Platform; // where the file lives, for re-resolving its URL
  fileId?: string;
  fileName?: string;
  performer?: string;
  title?: string;

  // location / contact
  latitude?: number;
  longitude?: number;
  phoneNumber?: string;
  firstName?: string;
  lastName?: string;

  // mapping to complete on success
  mappingId?: number;
  mappingSide?: "telegram" | "bale";
}

/** Enqueue a durable delivery job (used when an inline send fails transiently). */
export async function enqueueDeliver(ctx: SyncContext, payload: DeliverPayload, delaySeconds = 5): Promise<number> {
  return ctx.jobs.enqueue("deliver", payload, delaySeconds);
}

/** Execute a single delivery job. Returns the sent message id, or throws. */
async function runDeliver(ctx: SyncContext, payload: DeliverPayload): Promise<number> {
  const api = ctx.api(payload.destPlatform);
  let messageId: number;

  if (payload.kind === "media" && payload.fileId && payload.mediaKind && payload.sourcePlatform) {
    const sent = await transferMedia(
      ctx.api(payload.sourcePlatform),
      api,
      {
        kind: payload.mediaKind,
        fileId: payload.fileId,
        fileName: payload.fileName,
        performer: payload.performer,
        title: payload.title,
      },
      {
        chatId: payload.destChatId,
        caption: payload.text,
        parseMode: payload.parseMode,
        replyToMessageId: payload.replyToMessageId,
        messageThreadId: payload.messageThreadId,
        disableNotification: payload.disableNotification,
      },
    );
    messageId = sent.message_id;
  } else if (payload.kind === "location" && payload.latitude != null && payload.longitude != null) {
    const sent = await api.sendLocation(payload.destChatId, payload.latitude, payload.longitude, {
      replyToMessageId: payload.replyToMessageId,
    });
    messageId = sent.message_id;
  } else if (payload.kind === "contact" && payload.phoneNumber && payload.firstName) {
    const sent = await api.sendContact(payload.destChatId, payload.phoneNumber, payload.firstName, {
      lastName: payload.lastName,
      replyToMessageId: payload.replyToMessageId,
    });
    messageId = sent.message_id;
  } else {
    const sent = await api.sendMessage({
      chatId: payload.destChatId,
      text: payload.text || "(empty)",
      parseMode: payload.parseMode,
      replyToMessageId: payload.replyToMessageId,
      messageThreadId: payload.messageThreadId,
      disableNotification: payload.disableNotification,
    });
    messageId = sent.message_id;
  }

  // Complete the mapping side if requested.
  if (payload.mappingId && payload.mappingSide) {
    if (payload.mappingSide === "bale") {
      await ctx.mappings.setBaleSide(payload.mappingId, payload.destChatId, String(messageId));
    } else {
      await ctx.mappings.setTelegramSide(payload.mappingId, payload.destChatId, String(messageId));
    }
  }
  return messageId;
}

/**
 * Process a batch of due jobs. Called from the scheduled (cron) handler and the
 * admin /retry action. Reschedules transient failures with backoff up to the
 * configured max retry count, then marks them dead and notifies the admin.
 */
export async function processDueJobs(ctx: SyncContext, limit = 10): Promise<number> {
  const maxRetries = await ctx.settings.getNumber("max_retry_count", 4);
  const jobs = await ctx.jobs.due(limit);
  let processed = 0;

  for (const job of jobs) {
    await ctx.jobs.markInProgress(job.id);
    try {
      if (job.operation === "deliver") {
        await runDeliver(ctx, JSON.parse(job.payload) as DeliverPayload);
      }
      await ctx.jobs.markDone(job.id);
      processed++;
    } catch (err) {
      const attempt = job.attempt_count + 1;
      const msg = err instanceof Error ? err.message : String(err);
      if (isRetryable(err) && attempt < maxRetries) {
        await ctx.jobs.reschedule(job.id, attempt, backoffSeconds(attempt), msg);
      } else {
        await ctx.jobs.markDead(job.id, msg);
        await ctx.errors.record({
          platform: err instanceof ApiError ? undefined : undefined,
          operation: `job:${job.operation}`,
          errorMessage: msg,
        });
        await ctx.notifyAdmin(`❌ Job #${job.id} (${job.operation}) failed permanently: ${msg}`);
      }
    }
  }
  return processed;
}
