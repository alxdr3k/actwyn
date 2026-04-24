// Personal Agent P0 — /doctor.
//
// Spec: HLD §16.1 + DEC-017 (single command; each check tagged
// quick/deep with category, duration_ms, status). Also PRD §14.1
// storage_sync backlog contract and HLD §13.5 "attachment capture
// failures" separate surfacing.
//
// This module runs a checklist of pure / in-process checks. Real
// network checks (telegram API reachable, S3 smoke, disk) are injected
// so tests stay fast and deterministic.

import type { DbHandle } from "~/db.ts";
import { buildStatusReport } from "~/commands/status.ts";
import { appliedVersions } from "~/db/migrator.ts";

export type CheckCategory = "quick" | "deep";
export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  readonly name: string;
  readonly category: CheckCategory;
  readonly status: CheckStatus;
  readonly duration_ms: number;
  readonly detail?: string | undefined;
}

export interface DoctorDeps {
  readonly db: DbHandle;
  readonly required_bun_version: string;
  readonly current_bun_version: string;
  readonly bootstrap_whoami: boolean;
  /** Expected highest migration version (e.g. 2 for 001 + 002). */
  readonly expected_schema_version?: number | undefined;
  /** Pinned Claude version string from 03_RISK_SPIKES.md. */
  readonly pinned_claude_version?: string | undefined;
  /** ms threshold for "stale" pending rows. Default: 4 hours. */
  readonly stale_threshold_ms?: number | undefined;
  /** Optional hooks for network/subprocess checks (injectable for tests). */
  readonly config_ok?: (() => { ok: boolean; detail?: string }) | undefined;
  readonly redaction_self_test?: (() => { ok: boolean; detail?: string }) | undefined;
  readonly telegram_ping?: () => Promise<{ ok: boolean; detail?: string }>;
  readonly s3_ping?: () => Promise<{ ok: boolean; detail?: string }>;
  readonly claude_version?: () => Promise<{ ok: boolean; version?: string; detail?: string }>;
  readonly disk_check?: () => Promise<{ ok: boolean; detail?: string }>;
  readonly claude_lockdown_smoke?: () => Promise<{ ok: boolean; detail?: string }>;
  readonly subprocess_teardown_smoke?: () => Promise<{ ok: boolean; detail?: string }>;
}

export async function runDoctor(deps: DoctorDeps): Promise<readonly CheckResult[]> {
  const results: CheckResult[] = [];
  const staleMs = deps.stale_threshold_ms ?? 4 * 60 * 60 * 1000;

  // --- Quick checks ---

  if (deps.config_ok) {
    results.push(await timed("config_loaded", "quick", () => {
      const r = deps.config_ok!();
      return {
        status: r.ok ? "ok" : "fail",
        ...(r.detail ? { detail: r.detail } : {}),
      };
    }));
  }

  results.push(await timed("sqlite_open_wal", "quick", () => {
    const mode = deps.db.pragma("journal_mode");
    return mode === "wal" ? { status: "ok" } : { status: "fail", detail: `journal_mode=${mode}` };
  }));

  if (deps.expected_schema_version !== undefined) {
    results.push(await timed("migrations_applied", "quick", () => {
      const applied = appliedVersions(deps.db);
      const missing: number[] = [];
      for (let v = 1; v <= deps.expected_schema_version!; v++) {
        if (!applied.has(v)) missing.push(v);
      }
      if (missing.length > 0) {
        return { status: "fail", detail: `missing migrations: ${missing.join(", ")}` };
      }
      return { status: "ok", detail: `applied=${applied.size} expected=${deps.expected_schema_version}` };
    }));
  }

  results.push(await timed("bun_version", "quick", () => {
    if (deps.required_bun_version === deps.current_bun_version) {
      return { status: "ok", detail: deps.current_bun_version };
    }
    return {
      status: "warn",
      detail: `required=${deps.required_bun_version} current=${deps.current_bun_version}`,
    };
  }));

  if (deps.redaction_self_test) {
    results.push(await timed("redaction_boundary_quick", "quick", () => {
      const r = deps.redaction_self_test!();
      return {
        status: r.ok ? "ok" : "fail",
        ...(r.detail ? { detail: r.detail } : {}),
      };
    }));
  }

  if (deps.telegram_ping) {
    results.push(await timed("telegram_api_reachable", "quick", async () => {
      const r = await deps.telegram_ping!();
      return {
        status: r.ok ? "ok" : "fail",
        ...(r.detail ? { detail: r.detail } : {}),
      };
    }));
  }

  if (deps.claude_version) {
    results.push(await timed("claude_binary_present", "quick", async () => {
      const r = await deps.claude_version!();
      return {
        status: r.ok ? "ok" : "fail",
        ...(r.detail ? { detail: r.detail } : r.version ? { detail: r.version } : {}),
      };
    }));

    if (deps.pinned_claude_version) {
      results.push(await timed("claude_version_pinned", "quick", async () => {
        const r = await deps.claude_version!();
        if (!r.ok) {
          return { status: "fail", detail: "claude binary not present" };
        }
        const actual = r.version ?? "";
        const pinned = deps.pinned_claude_version!;
        if (actual === pinned) {
          return { status: "ok", detail: actual };
        }
        return {
          status: "warn",
          detail: `pinned=${pinned} actual=${actual}`,
        };
      }));
    }
  }

  results.push(await timed("bootstrap_whoami_guard", "quick", () => {
    // DEC-009: warn if BOOTSTRAP_WHOAMI is still true in steady state.
    if (!deps.bootstrap_whoami) return { status: "ok" };
    const row = deps.db
      .prepare<{ value: string }, [string]>(
        "SELECT value FROM settings WHERE key = ?",
      )
      .get("bootstrap_whoami.expires_at");
    if (row?.value) {
      const expiresAt = new Date(row.value);
      const nowMs = Date.now();
      const remainingMs = expiresAt.getTime() - nowMs;
      if (remainingMs <= 0) {
        return { status: "fail", detail: "BOOTSTRAP_WHOAMI expired — restart service to clear" };
      }
      const remainingMin = Math.ceil(remainingMs / 60_000);
      return { status: "warn", detail: `BOOTSTRAP_WHOAMI active, expires in ${remainingMin}m — disable before production` };
    }
    return { status: "warn", detail: "BOOTSTRAP_WHOAMI is enabled — disable before production" };
  }));

  results.push(await timed("storage_sync_backlog", "quick", () => {
    const r = buildStatusReport(deps.db);
    const backlog = r.storage_sync.pending + r.storage_sync.failed;
    return {
      status: backlog > 50 ? "warn" : "ok",
      detail: `pending=${r.storage_sync.pending} failed=${r.storage_sync.failed}`,
    };
  }));

  results.push(await timed("attachment_capture_failures", "quick", () => {
    const r = buildStatusReport(deps.db);
    return {
      status: r.attachment_capture_failures > 0 ? "warn" : "ok",
      detail: `count=${r.attachment_capture_failures}`,
    };
  }));

  // --- Deep checks ---

  if (deps.s3_ping) {
    results.push(await timed("s3_endpoint_smoke", "deep", async () => {
      const r = await deps.s3_ping!();
      return {
        status: r.ok ? "ok" : "fail",
        ...(r.detail ? { detail: r.detail } : {}),
      };
    }));
  }

  if (deps.claude_lockdown_smoke) {
    results.push(await timed("claude_lockdown_smoke", "deep", async () => {
      const r = await deps.claude_lockdown_smoke!();
      return {
        status: r.ok ? "ok" : "fail",
        ...(r.detail ? { detail: r.detail } : {}),
      };
    }));
  }

  if (deps.subprocess_teardown_smoke) {
    results.push(await timed("subprocess_teardown_smoke", "deep", async () => {
      const r = await deps.subprocess_teardown_smoke!();
      return {
        status: r.ok ? "ok" : "fail",
        ...(r.detail ? { detail: r.detail } : {}),
      };
    }));
  }

  if (deps.disk_check) {
    results.push(await timed("disk_free_ok", "deep", async () => {
      const r = await deps.disk_check!();
      return {
        status: r.ok ? "ok" : "warn",
        ...(r.detail ? { detail: r.detail } : {}),
      };
    }));
  }

  results.push(await timed("stale_pending_notifications", "deep", () => {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const row = deps.db
      .prepare<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM outbound_notifications
         WHERE status = 'pending' AND created_at < ?`,
      )
      .get(cutoff);
    const n = row?.n ?? 0;
    return {
      status: n > 0 ? "warn" : "ok",
      detail: `stale_count=${n} threshold_ms=${staleMs}`,
    };
  }));

  results.push(await timed("stale_pending_storage_sync", "deep", () => {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const row = deps.db
      .prepare<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM storage_objects
         WHERE capture_status IN ('pending', 'failed') AND created_at < ?`,
      )
      .get(cutoff);
    const n = row?.n ?? 0;
    return {
      status: n > 0 ? "warn" : "ok",
      detail: `stale_count=${n} threshold_ms=${staleMs}`,
    };
  }));

  results.push(await timed("orphan_processes", "deep", () => {
    // Provider runs still in 'started' state with a known process group ID
    // indicate orphaned subprocesses that startup recovery should have cleared.
    const row = deps.db
      .prepare<{ n: number }>(
        `SELECT COUNT(*) AS n FROM provider_runs
         WHERE status = 'started' AND process_group_id IS NOT NULL`,
      )
      .get();
    const n = row?.n ?? 0;
    return {
      status: n > 0 ? "warn" : "ok",
      detail: `count=${n}`,
    };
  }));

  results.push(await timed("interrupted_jobs", "deep", () => {
    const row = deps.db
      .prepare<{ n: number }>(
        `SELECT COUNT(*) AS n FROM jobs WHERE status = 'interrupted'`,
      )
      .get();
    const n = row?.n ?? 0;
    return { status: n > 0 ? "warn" : "ok", detail: `count=${n}` };
  }));

  return results;
}

async function timed(
  name: string,
  category: CheckCategory,
  fn: () => { status: CheckStatus; detail?: string } | Promise<{ status: CheckStatus; detail?: string }>,
): Promise<CheckResult> {
  const start = Date.now();
  try {
    const res = await fn();
    return {
      name,
      category,
      status: res.status,
      duration_ms: Date.now() - start,
      ...(res.detail ? { detail: res.detail } : {}),
    };
  } catch (e) {
    return {
      name,
      category,
      status: "fail",
      duration_ms: Date.now() - start,
      detail: (e as Error).message,
    };
  }
}
