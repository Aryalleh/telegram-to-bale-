import type { Env } from "../types/env.js";
import { SecureConfigRepo, WEB_MANAGED_SECRETS, type WebManagedSecret } from "../repositories/secure-config.js";
import { decryptValue } from "../security/crypto.js";

export type SecretSource = "dashboard" | "env" | "unset";

export interface ResolvedSecrets {
  telegramBotToken: string;
  baleBotToken: string;
  telegramWebhookSecret: string;
  baleWebhookSecret: string;
  adminApiSecret: string;
  /** Where each secret came from (for the dashboard status view). */
  sources: Record<string, SecretSource>;
}

/**
 * Resolve the effective secrets for a request.
 *
 * Bot tokens and webhook secrets are read from D1 (encrypted, entered via the
 * dashboard) when present, otherwise fall back to the Cloudflare env secret of
 * the same name. `ADMIN_API_SECRET` is env-only: it is the bootstrap password
 * used both to authenticate the dashboard and to derive the encryption key, so
 * it cannot live in the encrypted store it protects.
 */
export async function resolveSecrets(env: Env): Promise<ResolvedSecrets> {
  const repo = new SecureConfigRepo(env.DB);
  const sources: Record<string, SecretSource> = {};

  // Decrypt any dashboard-managed secrets.
  const fromDb: Partial<Record<WebManagedSecret, string>> = {};
  try {
    const rows = await repo.all();
    for (const row of rows) {
      if ((WEB_MANAGED_SECRETS as readonly string[]).includes(row.key)) {
        const plain = await decryptValue(env.ADMIN_API_SECRET ?? "", row.value_encrypted);
        if (plain) fromDb[row.key as WebManagedSecret] = plain;
      }
    }
  } catch {
    // secure_config table may not exist yet (pre-migration) — fall back to env.
  }

  const pick = (key: WebManagedSecret, envVal: string | undefined): string => {
    if (fromDb[key]) {
      sources[key] = "dashboard";
      return fromDb[key]!;
    }
    if (envVal) {
      sources[key] = "env";
      return envVal;
    }
    sources[key] = "unset";
    return "";
  };

  const telegramBotToken = pick("TELEGRAM_BOT_TOKEN", env.TELEGRAM_BOT_TOKEN);
  const baleBotToken = pick("BALE_BOT_TOKEN", env.BALE_BOT_TOKEN);
  const telegramWebhookSecret = pick("TELEGRAM_WEBHOOK_SECRET", env.TELEGRAM_WEBHOOK_SECRET);
  const baleWebhookSecret = pick("BALE_WEBHOOK_SECRET", env.BALE_WEBHOOK_SECRET);

  sources["ADMIN_API_SECRET"] = env.ADMIN_API_SECRET ? "env" : "unset";

  return {
    telegramBotToken,
    baleBotToken,
    telegramWebhookSecret,
    baleWebhookSecret,
    adminApiSecret: env.ADMIN_API_SECRET ?? "",
    sources,
  };
}
