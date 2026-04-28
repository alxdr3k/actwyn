import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  directoryUsageBytes,
  evaluateStorageCapacity,
  reducedSyncBatchLimit,
  type StorageCapacityThresholds,
} from "../../src/storage/capacity.ts";

const THRESHOLDS: StorageCapacityThresholds = {
  warning_used_bytes: 100,
  degraded_used_bytes: 200,
  hard_used_bytes: 300,
  warning_free_ratio: 0.20,
  degraded_free_ratio: 0.15,
  hard_free_ratio: 0.10,
  reduced_sync_batch_size: 2,
};

describe("storage capacity policy", () => {
  test("classifies warning, degraded, and critical levels", () => {
    expect(evaluateStorageCapacity({
      objects_path: "/objects",
      used_bytes: 101,
      free_bytes: 500,
      total_bytes: 1000,
      thresholds: THRESHOLDS,
    }).level).toBe("warn");

    expect(evaluateStorageCapacity({
      objects_path: "/objects",
      used_bytes: 201,
      free_bytes: 500,
      total_bytes: 1000,
      thresholds: THRESHOLDS,
    }).level).toBe("degraded");

    const critical = evaluateStorageCapacity({
      objects_path: "/objects",
      used_bytes: 301,
      free_bytes: 500,
      total_bytes: 1000,
      thresholds: THRESHOLDS,
    });
    expect(critical.level).toBe("critical");
    expect(critical.long_term_writes_allowed).toBe(false);
  });

  test("free-space thresholds also classify capacity pressure", () => {
    const critical = evaluateStorageCapacity({
      objects_path: "/objects",
      used_bytes: 10,
      free_bytes: 9,
      total_bytes: 100,
      thresholds: THRESHOLDS,
    });
    expect(critical.level).toBe("critical");
    expect(critical.reasons.join(" ")).toContain("free_disk<10%");
  });

  test("directoryUsageBytes sums nested regular files", () => {
    const dir = mkdtempSync(join(tmpdir(), "actwyn-capacity-"));
    try {
      mkdirSync(join(dir, "nested"));
      writeFileSync(join(dir, "a.bin"), new Uint8Array([1, 2, 3]));
      writeFileSync(join(dir, "nested", "b.bin"), new Uint8Array([4, 5]));
      expect(directoryUsageBytes(dir)).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("degraded or critical capacity reduces sync batch size", () => {
    const degraded = evaluateStorageCapacity({
      objects_path: "/objects",
      used_bytes: 250,
      free_bytes: 500,
      total_bytes: 1000,
      thresholds: THRESHOLDS,
    });
    expect(reducedSyncBatchLimit(degraded)).toBe(2);
    expect(reducedSyncBatchLimit(degraded, 1)).toBe(1);
  });
});
