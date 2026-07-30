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
