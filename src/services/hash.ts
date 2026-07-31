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
/** Fingerprint of plain text, normalized to letters/digits only (markdown,
 * emoji, punctuation and spacing removed) so it survives a render round-trip. */
export function textFingerprint(text: string): string {
  const normalized = (text ?? "").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
  return contentHash(normalized);
}

function normalize(s: string): string {
  return s.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

/**
 * Fingerprint of a *received* message by its essential content. Location and
 * contact messages fingerprint by their coordinates / phone (they are sent
 * natively, so the echo is the same type); everything else fingerprints by its
 * visible text + media kind. This is what the loop guard compares an incoming
 * message against, and it matches the value stored when the mirror was sent.
 */
export function postFingerprint(msg: Message): string {
  if (msg.location && !msg.venue) {
    const lat = msg.location.latitude.toFixed(5);
    const lng = msg.location.longitude.toFixed(5);
    return contentHash(`loc:${lat},${lng}`);
  }
  if (msg.contact) {
    return contentHash(`con:${normalize(msg.contact.phone_number)}`);
  }
  const media = extractMedia(msg);
  return contentHash(`${normalize(msg.text ?? msg.caption ?? "")}::${media?.kind ?? ""}`);
}

/**
 * Fingerprint of *outgoing* text/media content (what we actually send, after
 * decoration such as quotes and signatures). Stored as a mirror's content_hash
 * so the echo — which is exactly this content re-received — matches it, closing
 * the loop even when the sent content differs from the original message.
 */
export function outgoingPostFingerprint(bodyText: string, mediaKind?: string): string {
  return contentHash(`${normalize(bodyText)}::${mediaKind ?? ""}`);
}
