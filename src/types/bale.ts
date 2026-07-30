/**
 * Bale Bot API types.
 *
 * Bale implements a Telegram-compatible Bot API surface, so we reuse the
 * Telegram type definitions. This module exists as the canonical import point
 * for Bale-side code and to give the shapes Bale-flavored names.
 */
export type {
  Update,
  Message,
  Chat,
  User,
  MessageEntity,
  PhotoSize,
  FileBase,
  Video,
  Audio,
  Voice,
  Animation,
  Location,
  Contact,
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  TgFile as BaleFile,
  ApiResponse,
} from "./telegram.js";
