// Personal Agent P0 — Telegram Bot API types (subset).
//
// We consume `allowed_updates = ["message"]` only (HLD §9.1), so
// this type surface is deliberately small: only the fields we
// inspect at the inbound boundary. Unknown fields in the real
// payload are tolerated and carried through as `raw_update_json`.
//
// Reference: https://core.telegram.org/bots/api#update

export interface TelegramUser {
  readonly id: number;
  readonly is_bot?: boolean;
  readonly first_name?: string;
  readonly last_name?: string;
  readonly username?: string;
}

export interface TelegramChat {
  readonly id: number;
  readonly type?: string;
}

export interface TelegramPhotoSize {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly width: number;
  readonly height: number;
  readonly file_size?: number;
}

export interface TelegramDocument {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly file_name?: string;
  readonly mime_type?: string;
  readonly file_size?: number;
}

export interface TelegramAudio {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly duration?: number;
  readonly mime_type?: string;
  readonly file_size?: number;
  readonly title?: string;
}

export interface TelegramVideo {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly width: number;
  readonly height: number;
  readonly duration?: number;
  readonly mime_type?: string;
  readonly file_size?: number;
}

export interface TelegramVoice {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly duration?: number;
  readonly mime_type?: string;
  readonly file_size?: number;
}

export interface TelegramMessage {
  readonly message_id: number;
  readonly date: number;
  readonly from?: TelegramUser;
  readonly chat: TelegramChat;
  readonly text?: string;
  readonly caption?: string;
  // Attachments. Telegram provides PHOTO as an array of sizes;
  // inbound picks the largest by area.
  readonly photo?: readonly TelegramPhotoSize[];
  readonly document?: TelegramDocument;
  readonly audio?: TelegramAudio;
  readonly video?: TelegramVideo;
  readonly voice?: TelegramVoice;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  // Types we ignore in P0 per HLD §9.1 / PRD §8.2.
  readonly edited_message?: unknown;
  readonly callback_query?: unknown;
  readonly inline_query?: unknown;
  readonly channel_post?: unknown;
  readonly edited_channel_post?: unknown;
  readonly my_chat_member?: unknown;
  readonly chat_member?: unknown;
}

export interface GetUpdatesResponse {
  readonly ok: boolean;
  readonly result?: readonly TelegramUpdate[];
  readonly description?: string;
  readonly error_code?: number;
}
