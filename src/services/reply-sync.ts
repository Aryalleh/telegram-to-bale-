import type { Message } from "../types/telegram.js";
import type { Platform } from "../types/env.js";
import type { MessageMapping } from "../repositories/message-mappings.js";
import { SyncContext } from "./context.js";

/**
 * Reply/standalone-message policy for discussion groups.
 *
 * The project requires **bidirectional** comment synchronization: every genuine
 * user comment in either discussion group is mirrored to the other. Bot-authored
 * mirrors and auto-forwarded post copies are already filtered out upstream
 * (dispatch + syncComment), so any message reaching this point is a real user
 * message and is eligible in both directions.
 *
 * The `transfer_standalone_bale_messages` setting remains available only as an
 * opt-out: set it to "false" to restrict Bale→Telegram mirroring to messages
 * that reply to an already-synchronized message. It defaults to allowing all.
 */
export async function passesReplyPolicy(
  _ctx: SyncContext,
  _source: Platform,
  _msg: Message,
  _parentMapping: MessageMapping | null,
): Promise<boolean> {
  // Every message that reaches this point is a genuine user comment (bot mirrors
  // and auto-forwarded post copies are filtered upstream), so mirror it in both
  // directions per the project's bidirectional-comment requirement.
  return true;
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
