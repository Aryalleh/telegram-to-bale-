import type { Env } from "../types/env.js";
import { BotApiClient } from "./bot-api.js";

/** Construct a Bot API client bound to the Bale platform. */
export function baleApi(env: Env): BotApiClient {
  return new BotApiClient(env.BALE_API_BASE, env.BALE_BOT_TOKEN, "bale");
}
