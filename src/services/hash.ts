import type { Message } from "../types/telegram.js";
import { extractMedia } from "./media-transfer.js";

/** FNV-1a 32-bit hash, hex-encoded. Used as a content fingerprint for edit and
 * duplicate detection — cheap and dependency-free, sufficient for change checks. */
export function contentHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Platform-independent fingerprint of a post's content: its visible text (or
 * caption) plus the media kind. This is preserved across the original post, the
 * mirror we send, and the auto-forwarded copy in the discussion group (only
 * formatting/file_ids differ, not the visible text or media kind), so it can
 * match the same post across platforms — used for loop prevention, auto-forward
 * detection, and comment threading.
 */
export function postFingerprint(msg: Message): string {
  const text = (msg.text ?? msg.caption ?? "").trim();
  const media = extractMedia(msg);
  return contentHash(`${text}::${media?.kind ?? ""}`);
}
