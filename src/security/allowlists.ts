import type { ChannelConnection } from "../repositories/connections.js";
import type { SettingsRepo } from "../repositories/settings.js";

function parseIdList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * A chat is allowed if it is referenced by an enabled connection, OR explicitly
 * listed in the settings allowlists. Unknown chats are rejected even if the bot
 * happens to be a member — the system never syncs an unconfigured group.
 */
export function chatAllowlist(connections: ChannelConnection[]): Set<string> {
  const set = new Set<string>();
  for (const c of connections) {
    for (const id of [
      c.telegram_channel_id,
      c.telegram_discussion_id,
      c.bale_channel_id,
      c.bale_discussion_id,
    ]) {
      if (id) set.add(String(id));
    }
  }
  return set;
}

export async function isChatAllowed(
  chatId: string | number,
  connections: ChannelConnection[],
  settings: SettingsRepo,
): Promise<boolean> {
  const id = String(chatId);
  if (chatAllowlist(connections).has(id)) return true;

  const extra = new Set<string>([
    ...parseIdList(await settings.get("allowed_telegram_channel_id")),
    ...parseIdList(await settings.get("allowed_telegram_discussion_id")),
    ...parseIdList(await settings.get("allowed_bale_channel_id")),
    ...parseIdList(await settings.get("allowed_bale_discussion_id")),
  ]);
  return extra.has(id);
}

/** Whether a given user id may run administrator bot commands. */
export async function isAdminUser(
  platform: "telegram" | "bale",
  userId: number,
  settings: SettingsRepo,
): Promise<boolean> {
  const key = platform === "telegram" ? "admin_telegram_user_ids" : "admin_bale_user_ids";
  return parseIdList(await settings.get(key)).has(String(userId));
}
