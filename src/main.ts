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
import { createClaudeAdapter } from "~/providers/claude.ts";
import { runDoctor } from "~/commands/doctor.ts";
import { runWorkerLoop } from "~/queue/worker.ts";
import { runStartupRecovery } from "~/startup/recovery.ts";
import { BunS3Transport } from "~/storage/s3.ts";
import { MagicMimeProbe } from "~/storage/mime.ts";
import { BotAPITransport } from "~/telegram/bot_api.ts";
import { runPoller } from "~/telegram/poller.ts";

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

  const recovery = runStartupRecovery(db, {
    events,
    kill_orphan: (pgid) => {
      try {
        process.kill(-pgid, 0); // check alive
      } catch {
        return "already_gone";
      }
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // best-effort; log via events but don't crash boot
      }
      return "alive_killed";
    },
  });
  events.info("boot.recovery", {
    interrupted: recovery.interrupted.length,
    requeued: recovery.requeued.length,
    remained_interrupted: recovery.remained_interrupted.length,
    orphans_killed: recovery.orphans_killed.length,
  });

  // DEC-009: record bootstrap expiry timestamp when BOOTSTRAP_WHOAMI=true.
  if (config.bootstrap_whoami) {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    db.prepare<unknown, [string]>(
      `INSERT INTO settings(key, value, updated_at)
       VALUES('bootstrap_whoami.expires_at', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(expiresAt);
    events.warn("boot.bootstrap_whoami.enabled", { expires_at: expiresAt });
  }

  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  process.on("SIGINT", () => controller.abort());

  // P0 composition root — real transports wired here.
  const botApi = new BotAPITransport(config.telegram.bot_token);
  const transport = botApi;
  const fileTransport = botApi;

  const mime = new MagicMimeProbe();

  const adapter = createClaudeAdapter({
    binary: config.runtime.claude_binary,
    redactor,
    cwd: process.cwd(),
  });

  // Advisory profile for summary_generation jobs (HLD §4.4 / AC-PROV-014).
  const summaryAdapter = createClaudeAdapter({
    binary: config.runtime.claude_binary,
    profile: "advisory",
    max_turns: 2,
    redactor,
    cwd: process.cwd(),
  });

  const s3 = new BunS3Transport({
    endpoint: config.s3.endpoint,
    bucket: config.s3.bucket,
    region: config.s3.region,
    access_key_id: config.s3.access_key_id,
    secret_access_key: config.s3.secret_access_key,
  });

  const localObjectsPath = process.env.ACTWYN_OBJECTS_PATH ?? "/var/lib/actwyn/objects";
  const memoryBasePath = process.env.ACTWYN_MEMORY_PATH ?? "/var/lib/actwyn/memory";

  const inbound = {
    db,
    redactor,
    config: {
      authorized_user_ids: new Set([config.telegram.authorized_user_id]),
      bootstrap_whoami: config.bootstrap_whoami,
      attachment: { max_inbound_size_bytes: 20 * 1024 * 1024 },
      s3_bucket: config.s3.bucket,
    },
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
  } as const;

  const doctorDeps = {
    db,
    required_bun_version: config.runtime.required_bun_version,
    current_bun_version: Bun.version,
    bootstrap_whoami: config.bootstrap_whoami,
    expected_schema_version: 3,
    config_ok: () => {
      const missing: string[] = [];
      if (!config.telegram.bot_token) missing.push("TELEGRAM_BOT_TOKEN");
      if (!config.telegram.authorized_user_id) missing.push("AUTHORIZED_TELEGRAM_USER_ID");
      if (!config.s3.endpoint) missing.push("S3_ENDPOINT");
      if (!config.s3.bucket) missing.push("S3_BUCKET");
      if (missing.length > 0) {
        return { ok: false, detail: `empty fields: ${missing.join(", ")}` };
      }
      return { ok: true, detail: `path=${config.config_path}` };
    },
    redaction_self_test: () => {
      const sentinel = "Bearer actwyn_selftest_abc123XYZ_sentinel";
      const result = redactor.apply(sentinel).text;
      const ok = !result.includes("actwyn_selftest_abc123XYZ_sentinel");
      return ok ? { ok: true } : { ok: false, detail: "bearer token not redacted" };
    },
    s3_ping: () => s3.ping(),
    telegram_ping: async () => {
      try {
        const res = await fetch(`https://api.telegram.org/bot${config.telegram.bot_token}/getMe`);
        return res.ok ? { ok: true } : { ok: false, detail: `HTTP ${res.status}` };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
    claude_version: async () => {
      try {
        const proc = Bun.spawn([config.runtime.claude_binary, "--version"], { stdout: "pipe", stderr: "pipe" });
        const code = await proc.exited;
        if (code !== 0) return { ok: false, detail: `exit_code=${code}` };
        const out = await new Response(proc.stdout).text();
        return { ok: true, version: out.trim() };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
  };

  // HLD §7.9 step 6 / §16.2: boot-time doctor summary.
  // Runs quick checks only at boot (deep checks skipped — no s3_ping/claude hooks
  // during the blocking pre-loop phase; they run on-demand via /doctor command).
  try {
    const bootChecks = await runDoctor({
      db: doctorDeps.db,
      required_bun_version: doctorDeps.required_bun_version,
      current_bun_version: doctorDeps.current_bun_version,
      bootstrap_whoami: doctorDeps.bootstrap_whoami,
      expected_schema_version: doctorDeps.expected_schema_version,
      config_ok: doctorDeps.config_ok,
      redaction_self_test: doctorDeps.redaction_self_test,
    });
    const rolled = bootChecks.reduce(
      (acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
    events.info("boot_doctor", {
      ok: rolled["ok"] ?? 0,
      warn: rolled["warn"] ?? 0,
      fail: rolled["fail"] ?? 0,
      checks: bootChecks.map((r) => ({ name: r.name, status: r.status, ...(r.detail ? { detail: r.detail } : {}) })),
    });
  } catch (e) {
    events.warn("boot_doctor.error", { error: (e as Error).message });
  }

  // Launch loops concurrently; both honour the AbortSignal.
  await Promise.allSettled([
    runPoller(
      { db, inbound, transport, events, outbound: botApi },
      { signal: controller.signal },
    ),
    runWorkerLoop(
      {
        db,
        redactor,
        events,
        adapter,
        summaryAdapter,
        transport: fileTransport,
        mime,
        s3,
        outbound: botApi,
        newId: () => crypto.randomUUID(),
        now: () => new Date(),
        doctor: doctorDeps,
        config: {
          capture: {
            max_download_size_bytes: 20 * 1024 * 1024,
            local_path: (id) => `${localObjectsPath}/${id}`,
          },
          sync: {
            max_attempts: 3,
            local_path: (id) => `${localObjectsPath}/${id}`,
            bucket: config.s3.bucket,
          },
          memory_base_path: memoryBasePath,
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
