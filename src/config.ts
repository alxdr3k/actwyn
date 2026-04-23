// Personal Agent P0 — typed config loader.
//
// Responsibilities (HLD §4.1 / PRD Appendix F):
//   1. Read secrets + tunables from env + `config/runtime.json`.
//   2. Validate required fields at start-up; fail fast with a clear
//      message (no silent default for secrets).
//   3. Expose a frozen, typed view to the rest of the runtime.
//
// The loader does NOT read `.env` files on its own — systemd
// `EnvironmentFile=` or an external loader (e.g. `bun --env-file`)
// is responsible. This keeps the boundary between "which host
// provides these" and "what the app expects" explicit.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface RedactionConfig {
  readonly email_pii_mode: boolean;
  readonly phone_pii_mode: boolean;
  readonly high_entropy_min_length: number;
  readonly high_entropy_min_bits_per_char: number;
}

export interface RuntimeFileConfig {
  readonly required_bun_version: string;
  readonly log: { readonly level: LogLevel };
  readonly redaction: RedactionConfig;
  readonly claude_binary: string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppConfig {
  readonly telegram: {
    readonly bot_token: string;
    readonly authorized_user_id: number;
  };
  readonly s3: {
    readonly endpoint: string;
    readonly bucket: string;
    readonly region: string;
    readonly access_key_id: string;
    readonly secret_access_key: string;
  };
  readonly runtime: RuntimeFileConfig;
  readonly env: "development" | "production" | "test";
  readonly config_path: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(
    message: string,
    public readonly missing: readonly string[] = [],
  ) {
    super(message);
  }
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

const REQUIRED_ENV = [
  "TELEGRAM_BOT_TOKEN",
  "AUTHORIZED_TELEGRAM_USER_ID",
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AppConfig {
  const missing = REQUIRED_ENV.filter((k) => !env[k] || env[k]!.trim() === "");
  if (missing.length > 0) {
    throw new ConfigError(
      `missing required env vars: ${missing.join(", ")}`,
      missing,
    );
  }

  const authorizedUserRaw = env.AUTHORIZED_TELEGRAM_USER_ID!.trim();
  const authorizedUserId = Number(authorizedUserRaw);
  if (!Number.isInteger(authorizedUserId) || authorizedUserId <= 0) {
    throw new ConfigError(
      `AUTHORIZED_TELEGRAM_USER_ID must be a positive integer, got: ${authorizedUserRaw}`,
      ["AUTHORIZED_TELEGRAM_USER_ID"],
    );
  }

  const configPath = resolve(env.ACTWYN_CONFIG_PATH ?? "config/runtime.json");
  const runtime = parseRuntimeFile(configPath);

  const envMode = (env.NODE_ENV ?? "development") as AppConfig["env"];
  if (envMode !== "development" && envMode !== "production" && envMode !== "test") {
    throw new ConfigError(
      `NODE_ENV must be one of development|production|test, got: ${envMode}`,
    );
  }

  const cfg: AppConfig = {
    telegram: {
      bot_token: env.TELEGRAM_BOT_TOKEN!.trim(),
      authorized_user_id: authorizedUserId,
    },
    s3: {
      endpoint: env.S3_ENDPOINT!.trim(),
      bucket: env.S3_BUCKET!.trim(),
      region: env.S3_REGION!.trim(),
      access_key_id: env.S3_ACCESS_KEY_ID!.trim(),
      secret_access_key: env.S3_SECRET_ACCESS_KEY!.trim(),
    },
    runtime,
    env: envMode,
    config_path: configPath,
  };
  return deepFreeze(cfg);
}

function parseRuntimeFile(path: string): RuntimeFileConfig {
  if (!existsSync(path)) {
    throw new ConfigError(`runtime config file not found: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(
      `runtime config at ${path} is not valid JSON: ${(e as Error).message}`,
    );
  }
  if (!isRecord(raw)) {
    throw new ConfigError(`runtime config at ${path} must be a JSON object`);
  }

  const requiredBun = raw.required_bun_version;
  if (typeof requiredBun !== "string" || requiredBun.trim() === "") {
    throw new ConfigError(
      `runtime config missing string 'required_bun_version' (PRD Appendix F)`,
    );
  }

  const log = raw.log;
  if (!isRecord(log) || typeof log.level !== "string" ||
      !(LOG_LEVELS as readonly string[]).includes(log.level)) {
    throw new ConfigError(
      `runtime config 'log.level' must be one of ${LOG_LEVELS.join("|")}`,
    );
  }

  const redaction = raw.redaction;
  if (!isRecord(redaction)) {
    throw new ConfigError(`runtime config missing 'redaction' object`);
  }
  const parsed: RedactionConfig = {
    email_pii_mode: expectBool(redaction, "redaction.email_pii_mode"),
    phone_pii_mode: expectBool(redaction, "redaction.phone_pii_mode"),
    high_entropy_min_length: expectPositiveInt(
      redaction,
      "redaction.high_entropy_min_length",
    ),
    high_entropy_min_bits_per_char: expectPositiveNumber(
      redaction,
      "redaction.high_entropy_min_bits_per_char",
    ),
  };

  const claudeBinary =
    typeof raw.claude_binary === "string" && raw.claude_binary.trim() !== ""
      ? raw.claude_binary.trim()
      : "claude";

  return {
    required_bun_version: requiredBun.trim(),
    log: { level: log.level as LogLevel },
    redaction: parsed,
    claude_binary: claudeBinary,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function expectBool(obj: Record<string, unknown>, path: string): boolean {
  const key = path.split(".").pop()!;
  const v = obj[key];
  if (typeof v !== "boolean") {
    throw new ConfigError(`runtime config '${path}' must be a boolean`);
  }
  return v;
}

function expectPositiveInt(obj: Record<string, unknown>, path: string): number {
  const key = path.split(".").pop()!;
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new ConfigError(`runtime config '${path}' must be a positive integer`);
  }
  return v;
}

function expectPositiveNumber(obj: Record<string, unknown>, path: string): number {
  const key = path.split(".").pop()!;
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new ConfigError(`runtime config '${path}' must be a positive number`);
  }
  return v;
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const key of Object.keys(v)) {
      deepFreeze((v as Record<string, unknown>)[key]);
    }
    Object.freeze(v);
  }
  return v;
}
