import type { Message } from "../types/telegram.js";
import type { BotApiClient } from "./bot-api.js";

export type MediaKind = "photo" | "video" | "document" | "audio" | "voice" | "animation";

export interface MediaDescriptor {
  kind: MediaKind;
  fileId: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  performer?: string;
  title?: string;
}

/** Extract the primary media descriptor from a message, if any. */
export function extractMedia(msg: Message): MediaDescriptor | null {
  if (msg.photo && msg.photo.length) {
    // Highest practical resolution = last entry.
    const best = msg.photo[msg.photo.length - 1];
    return { kind: "photo", fileId: best.file_id, fileSize: best.file_size };
  }
  if (msg.animation) {
    return {
      kind: "animation",
      fileId: msg.animation.file_id,
      fileName: msg.animation.file_name,
      mimeType: msg.animation.mime_type,
      fileSize: msg.animation.file_size,
    };
  }
  if (msg.video) {
    return {
      kind: "video",
      fileId: msg.video.file_id,
      fileName: msg.video.file_name,
      mimeType: msg.video.mime_type,
      fileSize: msg.video.file_size,
    };
  }
  if (msg.video_note) {
    // Round "video message" — transferred as a regular video (video_note by URL
    // and with a caption is not broadly supported across platforms).
    return { kind: "video", fileId: msg.video_note.file_id, fileSize: msg.video_note.file_size };
  }
  if (msg.audio) {
    return {
      kind: "audio",
      fileId: msg.audio.file_id,
      fileName: msg.audio.file_name,
      mimeType: msg.audio.mime_type,
      fileSize: msg.audio.file_size,
      performer: msg.audio.performer,
      title: msg.audio.title,
    };
  }
  if (msg.voice) {
    return { kind: "voice", fileId: msg.voice.file_id, mimeType: msg.voice.mime_type, fileSize: msg.voice.file_size };
  }
  if (msg.document) {
    return {
      kind: "document",
      fileId: msg.document.file_id,
      fileName: msg.document.file_name,
      mimeType: msg.document.mime_type,
      fileSize: msg.document.file_size,
    };
  }
  return null;
}

export function hasMedia(msg: Message): boolean {
  return extractMedia(msg) !== null;
}

/**
 * Cloudflare Workers can stream a request body, but very large media may exceed
 * practical transfer limits. Anything above this threshold triggers the
 * configured fallback instead of a direct transfer.
 */
export const MAX_TRANSFER_BYTES = 45 * 1024 * 1024; // ~45MB

/**
 * Resolve a source file into a downloadable URL on the *source* platform. The
 * destination Bot API can then fetch that URL directly when sending, avoiding
 * buffering the whole file inside the Worker.
 */
export async function resolveSourceUrl(source: BotApiClient, fileId: string): Promise<string> {
  const file = await source.getFile(fileId);
  if (!file.file_path) throw new Error(`getFile returned no file_path for ${fileId}`);
  return source.fileDownloadUrl(file.file_path);
}

export function isTooLarge(desc: MediaDescriptor): boolean {
  return typeof desc.fileSize === "number" && desc.fileSize > MAX_TRANSFER_BYTES;
}

const DEFAULT_NAMES: Record<MediaKind, string> = {
  photo: "photo.jpg",
  video: "video.mp4",
  document: "file.bin",
  audio: "audio.mp3",
  voice: "voice.ogg",
  animation: "animation.mp4",
};

export interface TransferOptions {
  chatId: string | number;
  caption?: string;
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  replyMarkup?: unknown;
  replyToMessageId?: number;
  messageThreadId?: number;
  disableNotification?: boolean;
}

/**
 * Robustly transfer a media file from `sourceApi` to `destApi`.
 *
 * First tries the fast path (hand the destination the source download URL).
 * If the destination rejects the URL for that media type (e.g. voice on some
 * platforms), download the bytes into the Worker and upload them as
 * multipart/form-data instead. Throws on failure so callers can apply their own
 * document/text fallback.
 */
export async function transferMedia(
  sourceApi: BotApiClient,
  destApi: BotApiClient,
  media: MediaDescriptor,
  opts: TransferOptions,
): Promise<Message> {
  const url = await resolveSourceUrl(sourceApi, media.fileId);
  const common = {
    chatId: opts.chatId,
    caption: opts.caption,
    parseMode: opts.parseMode,
    replyMarkup: opts.replyMarkup,
    replyToMessageId: opts.replyToMessageId,
    messageThreadId: opts.messageThreadId,
    disableNotification: opts.disableNotification,
    fileName: media.fileName,
    performer: media.performer,
    title: media.title,
  };

  try {
    return await destApi.sendMedia(media.kind, { ...common, media: url });
  } catch (err) {
    // Only fall back to an upload for permanent rejections and when the file is
    // small enough to buffer.
    const permanent = err instanceof Error && err.name === "ApiError" && (err as { permanent?: boolean }).permanent === true;
    if (!permanent || isTooLarge(media)) throw err;

    const resp = await fetch(url);
    if (!resp.ok) throw err;
    const bytes = await resp.arrayBuffer();
    if (bytes.byteLength > MAX_TRANSFER_BYTES) throw err;

    return destApi.sendMediaUpload(media.kind, {
      chatId: opts.chatId,
      bytes,
      filename: media.fileName ?? DEFAULT_NAMES[media.kind],
      mimeType: media.mimeType,
      caption: opts.caption,
      parseMode: opts.parseMode,
      replyToMessageId: opts.replyToMessageId,
      messageThreadId: opts.messageThreadId,
      disableNotification: opts.disableNotification,
      replyMarkup: opts.replyMarkup,
      performer: media.performer,
      title: media.title,
    });
  }
}
