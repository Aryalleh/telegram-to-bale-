import type { Env, Platform } from "../types/env.js";
import { BotApiClient } from "./bot-api.js";
import { telegramApi } from "./telegram-api.js";
import { baleApi } from "./bale-api.js";
import { MappingsRepo } from "../repositories/message-mappings.js";
import { ProcessedUpdatesRepo } from "../repositories/processed-updates.js";
import { SyncJobsRepo } from "../repositories/sync-jobs.js";
import { SettingsRepo } from "../repositories/settings.js";
import { ConnectionsRepo } from "../repositories/connections.js";
import { ErrorsRepo } from "../repositories/errors.js";

/**
 * A per-request bundle of everything the sync services need. Constructed once
 * per webhook and threaded through the pipeline.
 */
export class SyncContext {
  readonly telegram: BotApiClient;
  readonly bale: BotApiClient;
  readonly mappings: MappingsRepo;
  readonly processed: ProcessedUpdatesRepo;
  readonly jobs: SyncJobsRepo;
  readonly settings: SettingsRepo;
  readonly connections: ConnectionsRepo;
  readonly errors: ErrorsRepo;

  /** Cached bot ids (getMe), resolved lazily. */
  private botIds: Partial<Record<Platform, number>> = {};

  constructor(readonly env: Env) {
    this.telegram = telegramApi(env);
    this.bale = baleApi(env);
    this.mappings = new MappingsRepo(env.DB);
    this.processed = new ProcessedUpdatesRepo(env.DB);
    this.jobs = new SyncJobsRepo(env.DB);
    this.settings = new SettingsRepo(env.DB);
    this.connections = new ConnectionsRepo(env.DB);
    this.errors = new ErrorsRepo(env.DB);
  }

  api(platform: Platform): BotApiClient {
    return platform === "telegram" ? this.telegram : this.bale;
  }

  async botId(platform: Platform): Promise<number | null> {
    if (this.botIds[platform] != null) return this.botIds[platform]!;
    try {
      const me = await this.api(platform).getMe();
      this.botIds[platform] = me.id;
      return me.id;
    } catch {
      return null;
    }
  }

  /** Notify the configured administrator chat (best effort). */
  async notifyAdmin(text: string): Promise<void> {
    const chat = await this.settings.get("admin_notification_chat");
    if (!chat) return;
    try {
      // Admin chat is assumed to be on Telegram by default.
      await this.telegram.sendMessage({ chatId: chat, text });
    } catch {
      /* best effort */
    }
  }
}
