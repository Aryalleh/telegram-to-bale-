import type { Env, Platform } from "../types/env.js";
import { BotApiClient } from "./bot-api.js";
import { resolveSecrets, type ResolvedSecrets } from "./secrets.js";
import { MappingsRepo } from "../repositories/message-mappings.js";
import { ProcessedUpdatesRepo } from "../repositories/processed-updates.js";
import { SyncJobsRepo } from "../repositories/sync-jobs.js";
import { SettingsRepo } from "../repositories/settings.js";
import { ConnectionsRepo } from "../repositories/connections.js";
import { ErrorsRepo } from "../repositories/errors.js";
import { SecureConfigRepo } from "../repositories/secure-config.js";

/**
 * A per-request bundle of everything the sync services need. Built once per
 * webhook via the async `create` factory (secrets are resolved from D1/env
 * before the Bot API clients are constructed).
 */
export class SyncContext {
  // Assigned in create() once secrets are resolved.
  telegram!: BotApiClient;
  bale!: BotApiClient;
  secrets!: ResolvedSecrets;

  readonly mappings: MappingsRepo;
  readonly processed: ProcessedUpdatesRepo;
  readonly jobs: SyncJobsRepo;
  readonly settings: SettingsRepo;
  readonly connections: ConnectionsRepo;
  readonly errors: ErrorsRepo;
  readonly secureConfig: SecureConfigRepo;

  /** Cached bot ids (getMe), resolved lazily. */
  private botIds: Partial<Record<Platform, number>> = {};

  private constructor(readonly env: Env) {
    this.mappings = new MappingsRepo(env.DB);
    this.processed = new ProcessedUpdatesRepo(env.DB);
    this.jobs = new SyncJobsRepo(env.DB);
    this.settings = new SettingsRepo(env.DB);
    this.connections = new ConnectionsRepo(env.DB);
    this.errors = new ErrorsRepo(env.DB);
    this.secureConfig = new SecureConfigRepo(env.DB);
  }

  /** Resolve secrets (D1-encrypted or env) and build the platform clients. */
  static async create(env: Env): Promise<SyncContext> {
    const ctx = new SyncContext(env);
    ctx.secrets = await resolveSecrets(env);
    ctx.telegram = new BotApiClient(env.TELEGRAM_API_BASE, ctx.secrets.telegramBotToken, "telegram");
    ctx.bale = new BotApiClient(env.BALE_API_BASE, ctx.secrets.baleBotToken, "bale");
    return ctx;
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
