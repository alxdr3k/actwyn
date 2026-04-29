// Tests for scripts/bench-context-compiler.ts
// Covers: argument parsing, fixture seeding, JSON output shape, threshold failure.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import {
  parseArgs,
  seedFixtures,
  runDbRead,
  runPacking,
  checkBudgets,
  BUDGET,
  type BenchmarkResult,
  type PhaseStats,
  runBenchmark,
} from "../../scripts/bench-context-compiler.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");
const SESSION = "bench-test-session";

let workdir: string;
let db: DbHandle;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-bench-test-"));
  db = openDatabase({ path: join(workdir, "t.db"), busyTimeoutMs: 250 });
  migrate(db, MIGRATIONS);
});

afterEach(() => {
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

// --- parseArgs ---

describe("parseArgs", () => {
  test("defaults: 100 iterations, json=false", () => {
    const args = parseArgs([]);
    expect(args.iterations).toBe(100);
    expect(args.json).toBe(false);
  });

  test("--iterations N sets iteration count", () => {
    const args = parseArgs(["--iterations", "42"]);
    expect(args.iterations).toBe(42);
  });

  test("--json sets json=true", () => {
    const args = parseArgs(["--json"]);
    expect(args.json).toBe(true);
  });

  test("combined flags parse correctly", () => {
    const args = parseArgs(["--iterations", "10", "--json"]);
    expect(args.iterations).toBe(10);
    expect(args.json).toBe(true);
  });

  test("non-positive --iterations throws", () => {
    expect(() => parseArgs(["--iterations", "0"])).toThrow();
    expect(() => parseArgs(["--iterations", "-5"])).toThrow();
  });

  test("non-numeric --iterations throws", () => {
    expect(() => parseArgs(["--iterations", "abc"])).toThrow();
  });
});

// --- seedFixtures ---

describe("seedFixtures", () => {
  test("returns correct row counts", () => {
    const stats = seedFixtures(db, SESSION);
    expect(stats.turns).toBe(20);
    expect(stats.memoryItems).toBe(50);
    expect(stats.summaries).toBe(1);
    expect(stats.judgments).toBe(20);
  });

  test("turns are actually in the DB", () => {
    seedFixtures(db, SESSION);
    const row = db.prepare<{ n: number }, [string]>(
      "SELECT COUNT(*) as n FROM turns WHERE session_id = ?",
    ).get(SESSION);
    expect(row?.n).toBe(20);
  });

  test("memory items are all active", () => {
    seedFixtures(db, SESSION);
    const row = db.prepare<{ n: number }, [string]>(
      "SELECT COUNT(*) as n FROM memory_items WHERE session_id = ? AND status = 'active'",
    ).get(SESSION);
    expect(row?.n).toBe(50);
  });

  test("summary is seeded", () => {
    seedFixtures(db, SESSION);
    const row = db.prepare<{ n: number }, [string]>(
      "SELECT COUNT(*) as n FROM memory_summaries WHERE session_id = ?",
    ).get(SESSION);
    expect(row?.n).toBe(1);
  });

  test("judgments are global active/eligible", () => {
    seedFixtures(db, SESSION);
    const row = db.prepare<{ n: number }, []>(
      `SELECT COUNT(*) as n FROM judgment_items
       WHERE lifecycle_status = 'active'
         AND activation_state = 'eligible'
         AND json_extract(scope_json, '$.global') = 1`,
    ).get();
    expect(row?.n).toBe(20);
  });
});

// --- runDbRead ---

describe("runDbRead", () => {
  test("returns turns, memoryItems, summary, judgments from seeded DB", () => {
    seedFixtures(db, SESSION);
    const data = runDbRead(db, SESSION);
    expect(data.turns.length).toBe(20);
    expect(data.memoryItems.length).toBe(50);
    expect(data.summary).toBeDefined();
    expect(data.summary).toContain("확인된 사실");
    expect(data.judgments.length).toBe(20);
  });

  test("returns empty arrays for empty session", () => {
    db.prepare<unknown, [string, string, string]>(
      "INSERT INTO sessions(id, chat_id, user_id) VALUES(?, ?, ?)",
    ).run(SESSION, "c", "u");
    const data = runDbRead(db, SESSION);
    expect(data.turns.length).toBe(0);
    expect(data.memoryItems.length).toBe(0);
    expect(data.summary).toBeUndefined();
    expect(data.judgments.length).toBe(0);
  });
});

// --- runPacking ---

describe("runPacking", () => {
  test("returns a non-empty string with seeded data", () => {
    seedFixtures(db, SESSION);
    const data = runDbRead(db, SESSION);
    const result = runPacking(data, "테스트 메시지");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("테스트 메시지");
  });

  test("returns user message when data is empty", () => {
    const emptyData = { turns: [], memoryItems: [], summary: undefined, judgments: [] };
    const result = runPacking(emptyData, "빈 데이터 메시지");
    expect(result).toContain("빈 데이터 메시지");
  });
});

// --- checkBudgets ---

describe("checkBudgets", () => {
  function stats(p50Ms: number, p95Ms: number, maxMs: number): PhaseStats {
    return { p50Ms, p95Ms, maxMs, iterations: 100 };
  }

  test("no violations when all within budget", () => {
    const violations = checkBudgets(stats(10, 30, 80), stats(5, 20, 40));
    expect(violations).toHaveLength(0);
  });

  test("detects db_read p95 violation", () => {
    const violations = checkBudgets(stats(10, 60, 80), stats(5, 20, 40));
    expect(violations.some((v) => v.phase === "db_read" && v.metric === "p95")).toBe(true);
  });

  test("detects db_read hard_cap violation", () => {
    const violations = checkBudgets(stats(10, 30, 200), stats(5, 20, 40));
    expect(violations.some((v) => v.phase === "db_read" && v.metric === "hard_cap")).toBe(true);
  });

  test("detects packing p95 violation", () => {
    const violations = checkBudgets(stats(10, 30, 80), stats(5, 60, 70));
    expect(violations.some((v) => v.phase === "packing" && v.metric === "p95")).toBe(true);
  });

  test("reports actualMs and limitMs correctly", () => {
    const violations = checkBudgets(stats(10, 99, 80), stats(5, 20, 40));
    const v = violations.find((x) => x.phase === "db_read" && x.metric === "p95");
    expect(v).toBeDefined();
    expect(v!.actualMs).toBe(99);
    expect(v!.limitMs).toBe(BUDGET.dbRead.p95Ms);
  });

  test("at-limit values do not trigger violation", () => {
    const violations = checkBudgets(
      stats(10, BUDGET.dbRead.p95Ms, BUDGET.dbRead.hardCapMs),
      stats(5, BUDGET.packing.p95Ms, 40),
    );
    expect(violations).toHaveLength(0);
  });
});

// --- runBenchmark (JSON output shape) ---

describe("runBenchmark", () => {
  test("returns BenchmarkResult with correct shape (5 iterations)", async () => {
    const result: BenchmarkResult = await runBenchmark(5);
    expect(result.meta.iterations).toBe(5);
    expect(typeof result.meta.bunVersion).toBe("string");
    expect(typeof result.meta.timestamp).toBe("string");
    expect(result.meta.fixture.turns).toBe(20);
    expect(result.meta.fixture.memoryItems).toBe(50);
    expect(result.meta.fixture.judgments).toBe(20);

    expect(typeof result.phases.db_read.p50Ms).toBe("number");
    expect(typeof result.phases.db_read.p95Ms).toBe("number");
    expect(typeof result.phases.db_read.maxMs).toBe("number");
    expect(result.phases.db_read.iterations).toBe(5);

    expect(typeof result.phases.packing.p50Ms).toBe("number");
    expect(typeof result.phases.packing.p95Ms).toBe("number");
    expect(result.phases.packing.iterations).toBe(5);

    // Integration: compile() exercised in both modes
    expect(typeof result.integration.compile_replay.p95Ms).toBe("number");
    expect(result.integration.compile_replay.iterations).toBe(5);
    expect(typeof result.integration.compile_resume.p95Ms).toBe("number");
    expect(result.integration.compile_resume.iterations).toBe(5);

    expect(result.budgets.db_read.p95Ms).toBe(BUDGET.dbRead.p95Ms);
    expect(result.budgets.db_read.hardCapMs).toBe(BUDGET.dbRead.hardCapMs);
    expect(result.budgets.packing.p95Ms).toBe(BUDGET.packing.p95Ms);

    expect(Array.isArray(result.violations)).toBe(true);
    expect(typeof result.pass).toBe("boolean");
  });

  test("result is valid JSON-serialisable", async () => {
    const result = await runBenchmark(3);
    expect(() => JSON.stringify(result)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(result)) as BenchmarkResult;
    expect(parsed.meta.iterations).toBe(3);
  });

  test("pass is false when violations array is non-empty", async () => {
    const result = await runBenchmark(3);
    expect(result.pass).toBe(result.violations.length === 0);
  });

  test("all timing values are non-negative", async () => {
    const result = await runBenchmark(3);
    expect(result.phases.db_read.p50Ms).toBeGreaterThanOrEqual(0);
    expect(result.phases.db_read.p95Ms).toBeGreaterThanOrEqual(0);
    expect(result.phases.db_read.maxMs).toBeGreaterThanOrEqual(0);
    expect(result.phases.packing.p50Ms).toBeGreaterThanOrEqual(0);
    expect(result.phases.packing.p95Ms).toBeGreaterThanOrEqual(0);
    expect(result.phases.packing.maxMs).toBeGreaterThanOrEqual(0);
  });
});
