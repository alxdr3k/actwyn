// Personal Agent P0 — /whoami.
// Returns the caller's Telegram user_id + chat_id. Honoured even
// for unauthorized senders when BOOTSTRAP_WHOAMI=true (PRD §8.3).

export interface WhoamiReply {
  readonly text: string;
}

export function whoamiReply(args: {
  user_id: string | null;
  chat_id: string | null;
  bootstrap: boolean;
}): WhoamiReply {
  const lines = [
    `user_id: ${args.user_id ?? "(unknown)"}`,
    `chat_id: ${args.chat_id ?? "(unknown)"}`,
  ];
  if (args.bootstrap) {
    lines.push("bootstrap_mode: true (disable in production)");
  }
  return { text: lines.join("\n") };
}
