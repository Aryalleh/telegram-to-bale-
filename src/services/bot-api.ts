import type { ApiResponse, Message, TgFile } from "../types/telegram.js";

export interface SendTextOptions {
  chatId: string | number;
  text: string;
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  replyToMessageId?: number;
  messageThreadId?: number;
  disableNotification?: boolean;
  replyMarkup?: unknown;
  disableWebPagePreview?: boolean;
}

export interface SendMediaOptions {
  chatId: string | number;
  /** A remote URL, or a file_id string the destination platform accepts. */
  media: string;
  caption?: string;
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  replyToMessageId?: number;
  messageThreadId?: number;
  disableNotification?: boolean;
  replyMarkup?: unknown;
  fileName?: string;
  /** For audio */
  performer?: string;
  title?: string;
}

export interface InputMediaItem {
  type: "photo" | "video" | "document" | "audio";
  media: string;
  caption?: string;
  parse_mode?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly retryAfter?: number,
    readonly permanent = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Error codes that indicate a permanent (non-retryable) failure. */
function isPermanent(code: number, description: string): boolean {
  if (code === 401 || code === 403) return true; // invalid token / bot kicked / no permission
  if (code === 400) {
    const d = description.toLowerCase();
    // 400s are usually permanent (bad request), except a few transient phrasings.
    if (d.includes("too many requests")) return false;
    return true;
  }
  return false;
}

/**
 * A thin, retry-aware wrapper over a Telegram-compatible Bot API. Both Telegram
 * and Bale expose the same method surface, so one client serves both — only the
 * base URL and token differ.
 */
export class BotApiClient {
  constructor(
    private readonly apiBase: string,
    private readonly token: string,
    readonly platform: "telegram" | "bale",
  ) {}

  private endpoint(method: string): string {
    // Telegram: https://api.telegram.org/bot<token>/<method>
    // Bale:     https://tapi.bale.ai/bot<token>/<method>
    return `${this.apiBase}/bot${this.token}/${method}`;
  }

  async call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify(cleanParams(params));
    const res = await fetch(this.endpoint(method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    return this.parse<T>(res, method);
  }

  private async parse<T>(res: Response, method: string): Promise<T> {
    let json: ApiResponse<T>;
    try {
      json = (await res.json()) as ApiResponse<T>;
    } catch {
      throw new ApiError(`Non-JSON response from ${this.platform} ${method} (HTTP ${res.status})`, res.status);
    }

    if (!json.ok) {
      const code = json.error_code ?? res.status;
      const desc = json.description ?? `HTTP ${res.status}`;
      throw new ApiError(
        `${this.platform} ${method} failed: ${desc}`,
        code,
        json.parameters?.retry_after,
        isPermanent(code, desc),
      );
    }
    return json.result as T;
  }

  /**
   * Send media by uploading the actual file bytes as multipart/form-data. Use
   * this when the destination does not accept a remote URL for a given media
   * type (e.g. voice on some platforms) — it works regardless of URL support.
   */
  async sendMediaUpload(
    kind: "photo" | "video" | "document" | "audio" | "voice" | "animation" | "sticker",
    o: {
      chatId: string | number;
      bytes: ArrayBuffer;
      filename: string;
      mimeType?: string;
      caption?: string;
      parseMode?: string;
      replyToMessageId?: number;
      messageThreadId?: number;
      disableNotification?: boolean;
      replyMarkup?: unknown;
      performer?: string;
      title?: string;
    },
  ): Promise<Message> {
    const form = new FormData();
    form.set("chat_id", String(o.chatId));
    if (o.caption && kind !== "sticker") form.set("caption", o.caption);
    if (o.parseMode && kind !== "sticker") form.set("parse_mode", o.parseMode);
    if (o.replyToMessageId != null) form.set("reply_to_message_id", String(o.replyToMessageId));
    if (o.messageThreadId != null) form.set("message_thread_id", String(o.messageThreadId));
    if (o.disableNotification) form.set("disable_notification", "true");
    if (o.replyMarkup) form.set("reply_markup", JSON.stringify(o.replyMarkup));
    if (o.performer) form.set("performer", o.performer);
    if (o.title) form.set("title", o.title);
    const blob = new Blob([o.bytes], o.mimeType ? { type: o.mimeType } : undefined);
    form.set(this.mediaField(kind), blob, o.filename);

    const method = this.mediaMethod(kind);
    const res = await fetch(this.endpoint(method), { method: "POST", body: form });
    return this.parse<Message>(res, method);
  }

  sendMessage(o: SendTextOptions): Promise<Message> {
    return this.call<Message>("sendMessage", {
      chat_id: o.chatId,
      text: o.text,
      parse_mode: o.parseMode,
      reply_to_message_id: o.replyToMessageId,
      message_thread_id: o.messageThreadId,
      disable_notification: o.disableNotification,
      reply_markup: o.replyMarkup,
      disable_web_page_preview: o.disableWebPagePreview,
    });
  }

  editMessageText(chatId: string | number, messageId: number, text: string, parseMode?: string, replyMarkup?: unknown): Promise<Message> {
    return this.call<Message>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: parseMode,
      reply_markup: replyMarkup,
    });
  }

  editMessageCaption(chatId: string | number, messageId: number, caption: string, parseMode?: string, replyMarkup?: unknown): Promise<Message> {
    return this.call<Message>("editMessageCaption", {
      chat_id: chatId,
      message_id: messageId,
      caption,
      parse_mode: parseMode,
      reply_markup: replyMarkup,
    });
  }

  private mediaMethod(kind: string): string {
    switch (kind) {
      case "photo": return "sendPhoto";
      case "video": return "sendVideo";
      case "document": return "sendDocument";
      case "audio": return "sendAudio";
      case "voice": return "sendVoice";
      case "animation": return "sendAnimation";
      case "sticker": return "sendSticker";
      default: return "sendDocument";
    }
  }

  private mediaField(kind: string): string {
    switch (kind) {
      case "photo": return "photo";
      case "video": return "video";
      case "document": return "document";
      case "audio": return "audio";
      case "voice": return "voice";
      case "animation": return "animation";
      case "sticker": return "sticker";
      default: return "document";
    }
  }

  sendMedia(kind: "photo" | "video" | "document" | "audio" | "voice" | "animation" | "sticker", o: SendMediaOptions): Promise<Message> {
    const params: Record<string, unknown> = {
      chat_id: o.chatId,
      caption: o.caption,
      parse_mode: o.parseMode,
      reply_to_message_id: o.replyToMessageId,
      message_thread_id: o.messageThreadId,
      disable_notification: o.disableNotification,
      reply_markup: o.replyMarkup,
      performer: o.performer,
      title: o.title,
    };
    if (kind === "sticker") {
      // sendSticker does not accept caption/parse_mode.
      delete params.caption;
      delete params.parse_mode;
    }
    params[this.mediaField(kind)] = o.media;
    return this.call<Message>(this.mediaMethod(kind), params);
  }

  sendMediaGroup(chatId: string | number, media: InputMediaItem[], opts?: { replyToMessageId?: number; messageThreadId?: number; disableNotification?: boolean }): Promise<Message[]> {
    return this.call<Message[]>("sendMediaGroup", {
      chat_id: chatId,
      media,
      reply_to_message_id: opts?.replyToMessageId,
      message_thread_id: opts?.messageThreadId,
      disable_notification: opts?.disableNotification,
    });
  }

  sendLocation(chatId: string | number, latitude: number, longitude: number, opts?: { replyToMessageId?: number; messageThreadId?: number }): Promise<Message> {
    return this.call<Message>("sendLocation", {
      chat_id: chatId,
      latitude,
      longitude,
      reply_to_message_id: opts?.replyToMessageId,
      message_thread_id: opts?.messageThreadId,
    });
  }

  sendContact(chatId: string | number, phoneNumber: string, firstName: string, opts?: { lastName?: string; replyToMessageId?: number; messageThreadId?: number }): Promise<Message> {
    return this.call<Message>("sendContact", {
      chat_id: chatId,
      phone_number: phoneNumber,
      first_name: firstName,
      last_name: opts?.lastName,
      reply_to_message_id: opts?.replyToMessageId,
      message_thread_id: opts?.messageThreadId,
    });
  }

  getMe(): Promise<{ id: number; username?: string; first_name?: string }> {
    return this.call("getMe", {});
  }

  /** Set a chat's photo by uploading the image bytes (multipart). */
  async setChatPhoto(chatId: string | number, bytes: ArrayBuffer, filename = "photo.jpg", mimeType = "image/jpeg"): Promise<boolean> {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("photo", new Blob([bytes], { type: mimeType }), filename);
    const res = await fetch(this.endpoint("setChatPhoto"), { method: "POST", body: form });
    return this.parse<boolean>(res, "setChatPhoto");
  }

  deleteChatPhoto(chatId: string | number): Promise<boolean> {
    return this.call<boolean>("deleteChatPhoto", { chat_id: chatId });
  }

  getFile(fileId: string): Promise<TgFile> {
    return this.call<TgFile>("getFile", { file_id: fileId });
  }

  /** Build the direct download URL for a file returned by getFile. */
  fileDownloadUrl(filePath: string): string {
    // Telegram: https://api.telegram.org/file/bot<token>/<file_path>
    // Bale:     https://tapi.bale.ai/file/bot<token>/<file_path>
    return `${this.apiBase}/file/bot${this.token}/${filePath}`;
  }
}

function cleanParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}
