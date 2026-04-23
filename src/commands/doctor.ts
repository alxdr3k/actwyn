// Personal Agent P0 — /doctor.
//
// Spec: HLD §16.1 + DEC-017 (single command; each check tagged
// quick/deep with category, duration_ms, status). Also PRD §14.1
// storage_sync backlog contract and HLD §13.5 "attachment capture
// failures" separate surfacing.
//
// This module runs a checklist of pure / in-process checks. Real
// network checks (telegram API reachable, S3 smoke) are injected
// so tests stay fast and deterministic.

import type { DbHandle } from "~/db.ts";
import { buildStatusReport } from "~/commands/status.ts";

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
  /** Optional hooks for network-bound checks. */
  readonly telegram_ping?: () => Promise<{ ok: boolean; detail?: string }>;
  readonly s3_ping?: () => Promise<{ ok: boolean; detail?: string }>;
  readonly claude_version?: () => Promise<{ ok: boolean; version?: string; detail?: string }>;
}

export async function runDoctor(deps: DoctorDeps): Promise<readonly CheckResult[]> {
  const results: CheckResult[] = [];

  results.push(await timed("sqlite_open_wal", "quick", () => {
    const mode = deps.db.pragma("journal_mode");
    return mode === "wal" ? { status: "ok" } : { status: "fail", detail: `journal_mode=${mode}` };
  }));

  results.push(await timed("bun_version", "quick", () => {
    if (deps.required_bun_version === deps.current_bun_version) {
      return { status: "ok", detail: deps.current_bun_version };
    }
    return {
      status: "warn",
      detail: `required=${deps.required_bun_version} current=${deps.current_bun_version}`,
    };
  }));

  results.push(await timed("bootstrap_whoami_guard", "quick", () => {
    // DEC-009: warn if BOOTSTRAP_WHOAMI is still true in steady state.
    return deps.bootstrap_whoami
      ? { status: "warn", detail: "BOOTSTRAP_WHOAMI is enabled — disable before production" }
      : { status: "ok" };
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

  results.push(await timed("interrupted_jobs", "quick", () => {
    const row = deps.db
      .prepare<{ n: number }>(
        `SELECT COUNT(*) AS n FROM jobs WHERE status = 'interrupted'`,
      )
      .get();
    const n = row?.n ?? 0;
    return { status: n > 0 ? "warn" : "ok", detail: `count=${n}` };
  }));

  if (deps.telegram_ping) {
    results.push(await timed("telegram_api_reachable", "deep", async () => {
      const r = await deps.telegram_ping!();
      return {
        status: r.ok ? "ok" : "fail",
        ...(r.detail ? { detail: r.detail } : {}),
      };
    }));
  }

  if (deps.s3_ping) {
    results.push(await timed("s3_reachable", "deep", async () => {
      const r = await deps.s3_ping!();
      return {
        status: r.ok ? "ok" : "fail",
        ...(r.detail ? { detail: r.detail } : {}),
      };
    }));
  }

  if (deps.claude_version) {
    results.push(await timed("claude_binary_present", "deep", async () => {
      const r = await deps.claude_version!();
      return {
        status: r.ok ? "ok" : "fail",
        ...(r.detail ? { detail: r.detail } : r.version ? { detail: r.version } : {}),
      };
    }));
  }

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
