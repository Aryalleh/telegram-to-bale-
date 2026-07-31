/**
 * Minimal Telegram Bot API types used by the sync engine.
 *
 * Bale's Bot API is modeled closely on Telegram's, so these shapes are reused
 * for Bale updates as well (see ./bale.ts, which re-exports them).
 */

export interface User {
  id: number;
  is_bot: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface Chat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  /** For channels, the id of the linked discussion group (and vice-versa). */
  linked_chat_id?: number;
}

export interface MessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: User;
  language?: string;
}

export interface PhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface FileBase {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  thumbnail?: PhotoSize;
}

export interface Video extends FileBase {
  width: number;
  height: number;
  duration: number;
}

export interface Audio extends FileBase {
  duration: number;
  performer?: string;
  title?: string;
}

export interface Voice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface Animation extends FileBase {
  width: number;
  height: number;
  duration: number;
}

/** Round "video message" (video note). */
export interface VideoNote {
  file_id: string;
  file_unique_id: string;
  length: number;
  duration: number;
  thumbnail?: PhotoSize;
  file_size?: number;
}

export interface Location {
  longitude: number;
  latitude: number;
}

export interface Contact {
  phone_number: string;
  first_name: string;
  last_name?: string;
  user_id?: number;
}

export interface Sticker {
  file_id: string;
  file_unique_id: string;
  type?: string;
  is_animated?: boolean;
  is_video?: boolean;
  emoji?: string;
  file_size?: number;
}

export interface Poll {
  question: string;
  options: { text: string }[];
  is_anonymous?: boolean;
  type?: string;
}

export interface Dice {
  emoji: string;
  value: number;
}

export interface Venue {
  location: Location;
  title: string;
  address: string;
}

export interface InlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface Message {
  message_id: number;
  message_thread_id?: number;
  from?: User;
  sender_chat?: Chat;
  /** Signature of the post author (channels with "sign messages" enabled). */
  author_signature?: string;
  chat: Chat;
  date: number;
  edit_date?: number;
  media_group_id?: string;

  /** Telegram sets this on the channel post auto-forwarded into the group. */
  is_automatic_forward?: boolean;
  reply_to_message?: Message;
  /** The specific fragment quoted when replying with a partial quote. */
  quote?: { text: string; entities?: MessageEntity[]; position?: number; is_manual?: boolean };

  /** Forward references (present on the discussion-group auto-forward copy). */
  forward_from_chat?: Chat;
  forward_from_message_id?: number;
  forward_origin?: { type?: string; chat?: Chat; message_id?: number };

  text?: string;
  caption?: string;
  entities?: MessageEntity[];
  caption_entities?: MessageEntity[];

  photo?: PhotoSize[];
  video?: Video;
  video_note?: VideoNote;
  document?: FileBase;
  audio?: Audio;
  voice?: Voice;
  animation?: Animation;
  location?: Location;
  contact?: Contact;
  sticker?: Sticker;
  poll?: Poll;
  dice?: Dice;
  venue?: Venue;

  reply_markup?: InlineKeyboardMarkup;

  // --- Service messages (not user content; mirroring skips these) ---
  new_chat_members?: User[];
  left_chat_member?: User;
  new_chat_title?: string;
  new_chat_photo?: PhotoSize[];
  delete_chat_photo?: boolean;
  pinned_message?: Message;
  group_chat_created?: boolean;
  supergroup_chat_created?: boolean;
  channel_chat_created?: boolean;
  message_auto_delete_timer_changed?: unknown;
}

export interface Update {
  update_id: number;
  message?: Message;
  edited_message?: Message;
  channel_post?: Message;
  edited_channel_post?: Message;
}

/** Result of getFile — used to build a download URL. */
export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}
