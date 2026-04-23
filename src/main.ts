// Personal Agent P0 — service entrypoint.
//
// This file is the one thing systemd launches. Boot sequence:
//
//   1. loadConfig() — fail fast on missing env / malformed
//      runtime.json.
//   2. openDatabase() — WAL, busy_timeout, FKs.
//   3. migrate() — forward-only, idempotent.
//   4. runStartupRecovery() — HLD §15 (must complete before the
//      worker loop starts accepting jobs).
//   5. Launch the poller loop (telegram inbound) and the worker
//      loop concurrently.
//   6. Install SIGTERM/SIGINT handler so systemd's stop signal
//      drains both loops cleanly.
//
// The actual Telegram transport + Claude adapter + S3 client
// factory injections are wired here and nowhere else — this
// module is the composition root.
//
// NOTE: this file is deliberately non-trivial to run in tests
// (it touches process.env, process signals, and long-poll HTTP).
// Its components (loadConfig, openDatabase, migrate,
// runStartupRecovery, runPoller, runWorkerLoop) each have their
// own test coverage.

import { loadConfig } from "~/config.ts";
import { openDatabase } from "~/db.ts";
import { migrate } from "~/db/migrator.ts";
import { createEmitter } from "~/observability/events.ts";
import { createRedactor } from "~/observability/redact.ts";
import { createFakeAdapter } from "~/providers/fake.ts";
import { runWorkerLoop } from "~/queue/worker.ts";
import { runStartupRecovery } from "~/startup/recovery.ts";
import { runPoller } from "~/telegram/poller.ts";
import type { TelegramTransport } from "~/telegram/poller.ts";
import type { TelegramFileTransport } from "~/telegram/attachment_capture.ts";

async function main(): Promise<void> {
  const config = loadConfig();

  const events = createEmitter({ level: config.runtime.log.level });
  events.info("boot.start", {
    env: config.env,
    bun_version: Bun.version,
    required_bun_version: config.runtime.required_bun_version,
  });

  const redactor = createRedactor(config.runtime.redaction, {
    exact_values: [
      config.telegram.bot_token,
      config.s3.access_key_id,
      config.s3.secret_access_key,
      ...collectSensitiveEnvValues(),
    ],
  });

  const db = openDatabase({ path: resolveDbPath() });
  migrate(db, resolveMigrationsPath());

  const recovery = runStartupRecovery(db, { events });
  events.info("boot.recovery", {
    interrupted: recovery.interrupted.length,
    requeued: recovery.requeued.length,
    remained_interrupted: recovery.remained_interrupted.length,
  });

  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  process.on("SIGINT", () => controller.abort());

  // P0 composition root — wire real transports here. In this
  // skeleton we panic on transport use so an operator notices if
  // they launch without a real Telegram client configured yet.
  const transport: TelegramTransport = {
    async getUpdates() {
      throw new Error(
        "Telegram transport not wired; src/main.ts composition root must be completed before production deploy",
      );
    },
  };

  const fileTransport: TelegramFileTransport = {
    async getFile() {
      throw new Error("Telegram file transport not wired");
    },
    async download() {
      throw new Error("Telegram file transport not wired");
    },
  };

  const mime = {
    async probe(): Promise<string> {
      return "application/octet-stream";
    },
  };

  const adapter = createFakeAdapter(); // replaced by createClaudeAdapter in prod wiring.

  const inbound = {
    db,
    redactor,
    config: {
      authorized_user_ids: new Set([config.telegram.authorized_user_id]),
      bootstrap_whoami: false,
      attachment: { max_inbound_size_bytes: 20 * 1024 * 1024 },
      s3_bucket: config.s3.bucket,
    },
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
  } as const;

  // Launch loops concurrently; both honour the AbortSignal.
  await Promise.allSettled([
    runPoller(
      { db, inbound, transport, events },
      { signal: controller.signal },
    ),
    runWorkerLoop(
      {
        db,
        redactor,
        events,
        adapter,
        transport: fileTransport,
        mime,
        newId: () => crypto.randomUUID(),
        now: () => new Date(),
        config: {
          capture: {
            max_download_size_bytes: 20 * 1024 * 1024,
            local_path: (id) => `/var/lib/actwyn/objects/${id}.bin`,
          },
        },
      },
      { signal: controller.signal },
    ),
  ]);

  events.info("boot.shutdown", {});
  db.close();
}

function resolveDbPath(): string {
  return process.env.ACTWYN_DB_PATH ?? "/var/lib/actwyn/actwyn.db";
}

function resolveMigrationsPath(): string {
  return process.env.ACTWYN_MIGRATIONS_PATH ?? "/opt/actwyn/migrations";
}

function collectSensitiveEnvValues(): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!v || v.length < 6) continue;
    if (/(TOKEN|SECRET|KEY|PASSWORD)$/i.test(k)) out.push(v);
  }
  return out;
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      event: "boot.crash",
      error_type: (e as Error).name,
      error_message: (e as Error).message,
    }));
    process.exit(1);
  });
}
