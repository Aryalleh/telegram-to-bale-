import type { Env } from "../types/env.js";
import { BotApiClient } from "./bot-api.js";

/** Construct a Bot API client bound to the Telegram platform. */
export function telegramApi(env: Env): BotApiClient {
  return new BotApiClient(env.TELEGRAM_API_BASE, env.TELEGRAM_BOT_TOKEN, "telegram");
}
