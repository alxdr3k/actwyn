// Personal Agent P0 — local artifact capacity policy (DEC-018).
//
// This module is read-only. It inspects the local artifact directory and
// filesystem free space, then classifies the result against configurable
// thresholds. Callers decide how to surface or enforce the classification.

import { existsSync, lstatSync, readdirSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type StorageCapacityLevel = "ok" | "warn" | "degraded" | "critical" | "unknown";

export interface StorageCapacityThresholds {
  readonly warning_used_bytes: number;
  readonly degraded_used_bytes: number;
  readonly hard_used_bytes: number;
  readonly warning_free_ratio: number;
  readonly degraded_free_ratio: number;
  readonly hard_free_ratio: number;
  readonly reduced_sync_batch_size: number;
}

export interface StorageCapacityReport {
  readonly level: StorageCapacityLevel;
  readonly objects_path: string | null;
  readonly used_bytes: number | null;
  readonly free_bytes: number | null;
  readonly total_bytes: number | null;
  readonly free_ratio: number | null;
  readonly reasons: readonly string[];
  readonly long_term_writes_allowed: boolean;
  readonly reduced_sync_batch_size: number;
  readonly detail: string;
}

export const DEFAULT_STORAGE_CAPACITY_THRESHOLDS: StorageCapacityThresholds = {
  warning_used_bytes: 1_000_000_000,
  degraded_used_bytes: 2_000_000_000,
  hard_used_bytes: 3_000_000_000,
  warning_free_ratio: 0.20,
  degraded_free_ratio: 0.15,
  hard_free_ratio: 0.10,
  reduced_sync_batch_size: 10,
};

export function evaluateStorageCapacity(args: {
  objects_path: string;
  used_bytes: number;
  free_bytes: number;
  total_bytes: number;
  thresholds?: StorageCapacityThresholds | undefined;
}): StorageCapacityReport {
  const thresholds = args.thresholds ?? DEFAULT_STORAGE_CAPACITY_THRESHOLDS;
  const freeRatio = args.total_bytes > 0 ? args.free_bytes / args.total_bytes : 0;
  const reasons: string[] = [];

  let level: StorageCapacityLevel = "ok";
  if (args.used_bytes > thresholds.warning_used_bytes) {
    level = maxLevel(level, "warn");
    reasons.push(`artifact_bytes>${formatBytes(thresholds.warning_used_bytes)}`);
  }
  if (freeRatio < thresholds.warning_free_ratio) {
    level = maxLevel(level, "warn");
    reasons.push(`free_disk<${formatPercent(thresholds.warning_free_ratio)}`);
  }
  if (args.used_bytes > thresholds.degraded_used_bytes) {
    level = maxLevel(level, "degraded");
    reasons.push(`artifact_bytes>${formatBytes(thresholds.degraded_used_bytes)}`);
  }
  if (freeRatio < thresholds.degraded_free_ratio) {
    level = maxLevel(level, "degraded");
    reasons.push(`free_disk<${formatPercent(thresholds.degraded_free_ratio)}`);
  }
  if (args.used_bytes > thresholds.hard_used_bytes) {
    level = maxLevel(level, "critical");
    reasons.push(`artifact_bytes>${formatBytes(thresholds.hard_used_bytes)}`);
  }
  if (freeRatio < thresholds.hard_free_ratio) {
    level = maxLevel(level, "critical");
    reasons.push(`free_disk<${formatPercent(thresholds.hard_free_ratio)}`);
  }

  const report: StorageCapacityReport = {
    level,
    objects_path: args.objects_path,
    used_bytes: args.used_bytes,
    free_bytes: args.free_bytes,
    total_bytes: args.total_bytes,
    free_ratio: freeRatio,
    reasons,
    long_term_writes_allowed: level !== "critical",
    reduced_sync_batch_size: thresholds.reduced_sync_batch_size,
    detail: "",
  };
  return { ...report, detail: formatStorageCapacityReport(report) };
}

export function readStorageCapacityReport(args: {
  objects_path: string;
  thresholds?: StorageCapacityThresholds | undefined;
}): StorageCapacityReport {
  const objectsPath = resolve(args.objects_path);
  const usedBytes = directoryUsageBytes(objectsPath);
  const statPath = nearestExistingPath(objectsPath);
  const stat = statfsSync(statPath);
  const blockSize = Number(stat.bsize);
  const totalBytes = Number(stat.blocks) * blockSize;
  const freeBytes = Number(stat.bavail) * blockSize;
  return evaluateStorageCapacity({
    objects_path: objectsPath,
    used_bytes: usedBytes,
    free_bytes: freeBytes,
    total_bytes: totalBytes,
    thresholds: args.thresholds,
  });
}

export function unknownStorageCapacityReport(error: unknown): StorageCapacityReport {
  const message = error instanceof Error ? error.message : String(error);
  const report: StorageCapacityReport = {
    level: "unknown",
    objects_path: null,
    used_bytes: null,
    free_bytes: null,
    total_bytes: null,
    free_ratio: null,
    reasons: [`capacity_check_failed:${message.slice(0, 120)}`],
    long_term_writes_allowed: true,
    reduced_sync_batch_size: DEFAULT_STORAGE_CAPACITY_THRESHOLDS.reduced_sync_batch_size,
    detail: "",
  };
  return { ...report, detail: formatStorageCapacityReport(report) };
}

export function formatStorageCapacityReport(report: StorageCapacityReport): string {
  if (report.level === "unknown") {
    return `unknown (${report.reasons.join(", ") || "capacity_check_failed"})`;
  }
  const used = report.used_bytes === null ? "unknown" : formatBytes(report.used_bytes);
  const free = report.free_ratio === null ? "unknown" : formatPercent(report.free_ratio);
  const reasons = report.reasons.length > 0 ? ` · ${report.reasons.join(", ")}` : "";
  const writeState = report.long_term_writes_allowed ? "long_term=allowed" : "long_term=blocked";
  return `${report.level} · used ${used} · free ${free} · ${writeState}${reasons}`;
}

export function reducedSyncBatchLimit(
  report: StorageCapacityReport | null,
  currentLimit?: number | undefined,
): number | undefined {
  if (!report || (report.level !== "degraded" && report.level !== "critical")) {
    return currentLimit;
  }
  const reduced = report.reduced_sync_batch_size;
  if (currentLimit === undefined) return reduced;
  return Math.min(currentLimit, reduced);
}

export function directoryUsageBytes(path: string): number {
  if (!existsSync(path)) return 0;
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return 0;
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let total = 0;
  for (const entry of readdirSync(path)) {
    total += directoryUsageBytes(resolve(path, entry));
  }
  return total;
}

function nearestExistingPath(path: string): string {
  let cur = resolve(path);
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
  return cur;
}

function maxLevel(a: StorageCapacityLevel, b: Exclude<StorageCapacityLevel, "unknown">): StorageCapacityLevel {
  const rank: Record<StorageCapacityLevel, number> = {
    unknown: -1,
    ok: 0,
    warn: 1,
    degraded: 2,
    critical: 3,
  };
  return rank[b] > rank[a] ? b : a;
}

function formatBytes(n: number): string {
  if (n >= 1_000_000_000) return `${trim(n / 1_000_000_000)}GB`;
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}MB`;
  if (n >= 1_000) return `${trim(n / 1_000)}KB`;
  return `${n}B`;
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
