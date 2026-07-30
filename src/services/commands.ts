import type { Message } from "../types/telegram.js";
import type { Platform } from "../types/env.js";
import { SyncContext } from "./context.js";
import { isAdminUser } from "../security/allowlists.js";
import { buildStatus, buildStats } from "./status.js";

/**
 * Handle administrator bot commands sent to the bot (typically in a private
 * chat or the discussion group). Returns true if the message was a command
 * that we handled, false otherwise.
 */
export async function handleCommand(ctx: SyncContext, platform: Platform, msg: Message): Promise<boolean> {
  const text = msg.text?.trim();
  if (!text || !text.startsWith("/")) return false;

  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.replace(/@.*$/, "").toLowerCase(); // strip @botname
  const api = ctx.api(platform);
  const chatId = String(msg.chat.id);

  // Authorization: only approved admin user ids may run commands.
  const userId = msg.from?.id;
  if (!userId || !(await isAdminUser(platform, userId, ctx.settings))) {
    // Silently ignore commands from non-admins to avoid leaking behavior.
    return true;
  }

  const reply = (t: string) => api.sendMessage({ chatId, text: t, parseMode: "Markdown", replyToMessageId: msg.message_id });

  switch (cmd) {
    case "/status": {
      await reply(await buildStatus(ctx));
      return true;
    }
    case "/stats": {
      await reply(await buildStats(ctx));
      return true;
    }
    case "/pause": {
      await ctx.settings.set("paused", "true");
      await reply("⏸ Synchronization *paused*.");
      return true;
    }
    case "/resume": {
      await ctx.settings.set("paused", "false");
      await reply("▶️ Synchronization *resumed*.");
      return true;
    }
    case "/pause_posts": {
      await ctx.settings.set("paused_posts", "true");
      await reply("⏸ Post synchronization paused.");
      return true;
    }
    case "/pause_comments": {
      await ctx.settings.set("paused_comments", "true");
      await reply("⏸ Comment synchronization paused.");
      return true;
    }
    case "/pause_telegram_to_bale": {
      await ctx.settings.set("sync_telegram_to_bale", "false");
      await reply("⏸ Telegram → Bale paused.");
      return true;
    }
    case "/pause_bale_to_telegram": {
      await ctx.settings.set("sync_bale_to_telegram", "false");
      await reply("⏸ Bale → Telegram paused.");
      return true;
    }
    case "/retry":
    case "/retry_failed": {
      const n = await ctx.jobs.retryFailed();
      await reply(`🔁 Requeued *${n}* failed job(s).`);
      return true;
    }
    case "/retry_message": {
      const id = Number(args[0]);
      if (!Number.isFinite(id)) return void (await reply("Usage: `/retry_message <mapping_id>`")), true;
      const m = await ctx.mappings.byId(id);
      await reply(m ? `Mapping ${id} found (type: ${m.message_type}, status: ${m.status}).` : `Mapping ${id} not found.`);
      return true;
    }
    case "/find_mapping": {
      const messageId = args[0];
      if (!messageId) return void (await reply("Usage: `/find_mapping <message_id>`")), true;
      const rows = await ctx.mappings.byAnyMessageId(messageId);
      if (!rows.length) return void (await reply(`No mapping for message ${messageId}.`)), true;
      const lines = rows.map(
        (r) => `#${r.id} ${r.message_type}: TG ${r.telegram_message_id ?? "—"} ↔ Bale ${r.bale_message_id ?? "—"} (${r.status})`,
      );
      await reply(lines.join("\n"));
      return true;
    }
    case "/mark_deleted": {
      const id = Number(args[0]);
      if (!Number.isFinite(id)) return void (await reply("Usage: `/mark_deleted <mapping_id>`")), true;
      await ctx.mappings.setStatus(id, "manually_deleted");
      await reply(`🗑 Mapping ${id} marked as manually deleted.`);
      return true;
    }
    case "/test_connection": {
      const results: string[] = [];
      for (const p of ["telegram", "bale"] as Platform[]) {
        try {
          const me = await ctx.api(p).getMe();
          results.push(`✅ ${p}: @${me.username ?? me.id}`);
        } catch (e) {
          results.push(`❌ ${p}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      await reply(results.join("\n"));
      return true;
    }
    default:
      return false;
  }
}
