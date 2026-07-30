import type { Message } from "../types/telegram.js";
import type { Platform } from "../types/env.js";
import type { MessageMapping } from "../repositories/message-mappings.js";
import { SyncContext } from "./context.js";

/**
 * Reply/standalone-message policy for discussion groups.
 *
 * Section 7 of the design: all Telegram discussion comments are mirrored to
 * Bale. Section 8: a Bale discussion message is only mirrored to Telegram when
 * it is a reply to an already-synchronized message — unless the administrator
 * has explicitly enabled mirroring of standalone Bale messages.
 *
 * With bidirectional sync enabled, the same guard is applied symmetrically and
 * governed by the `transfer_standalone_bale_messages` setting.
 */
export async function passesReplyPolicy(
  ctx: SyncContext,
  source: Platform,
  msg: Message,
  parentMapping: MessageMapping | null,
): Promise<boolean> {
  // A reply whose target we recognize is always eligible.
  if (parentMapping) return true;

  // A reply to the auto-forwarded channel post is a genuine top-level comment.
  if (msg.reply_to_message?.is_automatic_forward) return true;

  // Top-level Telegram comments (replies to the linked post) are mirrored.
  if (source === "telegram") return true;

  // Standalone Bale messages require explicit opt-in.
  return ctx.settings.getBool("transfer_standalone_bale_messages");
}

/**
 * When a reply's parent has been manually deleted, the reply cannot be attached
 * to the original message. It is published as a standalone message and flagged
 * as an orphaned reply for administrator awareness.
 */
export function isOrphanedReply(msg: Message, parentMapping: MessageMapping | null): boolean {
  const repliesToSomething = !!msg.reply_to_message && !msg.reply_to_message.is_automatic_forward;
  return repliesToSomething && parentMapping == null;
}
