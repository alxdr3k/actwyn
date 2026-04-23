// Personal Agent P0 — Telegram Bot API HTTP transport.
//
// Implements:
//   - TelegramTransport (getUpdates via long-poll)
//   - TelegramFileTransport (getFile + download via CDN)
//   - OutboundTransport (sendMessage)
//
// All three use direct `fetch` to api.telegram.org. No third-party
// libraries. The 429 retry-after header is surfaced as a
// TelegramSendError so the caller can back off (HLD §9.4).

import type { GetUpdatesArgs, TelegramTransport } from "~/telegram/poller.ts";
import type { TelegramFileHandle, TelegramFileTransport } from "~/telegram/attachment_capture.ts";
import {
  TelegramSendError,
  type OutboundTransport,
  type SendMessageArgs,
  type SendMessageResult,
} from "~/telegram/outbound.ts";
import type { TelegramUpdate } from "~/telegram/types.ts";

const BOT_API_BASE = "https://api.telegram.org";
const FILE_CDN_BASE = "https://api.telegram.org/file";

interface BotAPIResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export class BotAPITransport
  implements TelegramTransport, TelegramFileTransport, OutboundTransport
{
  private readonly base: string;
  private readonly fileCdn: string;

  constructor(
    private readonly botToken: string,
    opts: { base?: string; fileCdn?: string } = {},
  ) {
    this.base = opts.base ?? BOT_API_BASE;
    this.fileCdn = opts.fileCdn ?? FILE_CDN_BASE;
  }

  // ---------------------------------------------------------------
  // TelegramTransport
  // ---------------------------------------------------------------

  async getUpdates(args: GetUpdatesArgs): Promise<readonly TelegramUpdate[]> {
    const body: Record<string, unknown> = {
      offset: args.offset,
      timeout: args.timeout_seconds,
      allowed_updates: ["message"],
    };
    const data = await this.call<TelegramUpdate[]>("getUpdates", body);
    return data ?? [];
  }

  // ---------------------------------------------------------------
  // TelegramFileTransport
  // ---------------------------------------------------------------

  async getFile(file_id: string): Promise<TelegramFileHandle> {
    const data = await this.call<{ file_id: string; file_path?: string; file_size?: number }>(
      "getFile",
      { file_id },
    );
    if (!data?.file_path) {
      throw new Error(`getFile: no file_path returned for file_id=${file_id}`);
    }
    return {
      file_id,
      file_path: data.file_path,
      file_size: data.file_size ?? null,
    };
  }

  async download(handle: TelegramFileHandle): Promise<Uint8Array> {
    const url = `${this.fileCdn}/bot${this.botToken}/${handle.file_path}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`download: HTTP ${res.status} for file_path=${handle.file_path}`);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  // ---------------------------------------------------------------
  // OutboundTransport
  // ---------------------------------------------------------------

  async send(args: SendMessageArgs): Promise<SendMessageResult> {
    const data = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: args.chat_id,
      text: args.text,
    });
    if (!data?.message_id) {
      throw new TelegramSendError("sendMessage: no message_id in response", undefined, false);
    }
    return { telegram_message_id: String(data.message_id) };
  }

  // ---------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T | null> {
    const url = `${this.base}/bot${this.botToken}/${method}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`${method}: network error: ${(e as Error).message}`);
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After") ?? "30");
      throw new TelegramSendError(
        `${method}: rate limited (429)`,
        retryAfter,
        true,
      );
    }

    let json: BotAPIResponse<T>;
    try {
      json = await res.json() as BotAPIResponse<T>;
    } catch {
      throw new Error(`${method}: invalid JSON response (HTTP ${res.status})`);
    }

    if (!json.ok) {
      const retryable = res.status >= 500 || res.status === 429;
      throw new TelegramSendError(
        `${method}: ${json.description ?? "unknown error"} (code=${json.error_code})`,
        json.parameters?.retry_after,
        retryable,
      );
    }

    return json.result ?? null;
  }
}
