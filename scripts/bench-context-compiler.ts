#!/usr/bin/env bun
// perf(context): Context Compiler benchmark harness (ADR-0014 P4).
//
// Measures context compiler DB-read and packing phases separately
// against ADR-0014 budgets:
//   context compiler DB read  — p95 < 50ms, hard cap < 150ms
//   context packing / render  — p95 < 50ms
//
// Usage: bun run bench:context [--iterations N] [--json]
//   --iterations N  timed iterations per phase (default: 100)
//   --json          emit JSON to stdout instead of a human-readable table
//
// Exit code: 0 = all budgets met, 1 = at least one budget exceeded.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "~/db.ts";
import { migrate } from "~/db/migrator.ts";
import {
  buildContext,
  type JudgmentItemSlot,
  type MemoryItemSlot,
  type TurnSlot,
} from "~/context/builder.ts";
import { pack, renderAsMessage } from "~/context/packer.ts";
import { compile } from "~/context/compiler.ts";
import {
  proposeJudgment,
  approveProposedJudgment,
  commitApprovedJudgment,
  recordJudgmentSource,
  linkJudgmentEvidence,
} from "~/judgment/repository.ts";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const DEFAULT_ITERATIONS = 100;
const SESSION = "bench-session";

// --- ADR-0014 P4 budgets ---

export const BUDGET = {
  dbRead: { p95Ms: 50, hardCapMs: 150 },
  packing: { p95Ms: 50 },
} as const;

// --- arg parsing ---

export interface BenchArgs {
  readonly iterations: number;
  readonly json: boolean;
}

export function parseArgs(argv: string[]): BenchArgs {
  let iterations = DEFAULT_ITERATIONS;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--iterations" && i + 1 < argv.length) {
      const n = parseInt(argv[i + 1]!, 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`--iterations must be a positive integer, got: ${argv[i + 1]}`);
      }
      iterations = n;
      i++;
    } else if (argv[i] === "--json") {
      json = true;
    }
  }
  return { iterations, json };
}

// --- fixture seeding ---

export interface FixtureStats {
  readonly turns: number;
  readonly memoryItems: number;
  readonly summaries: number;
  readonly judgments: number;
}

export function seedFixtures(db: DbHandle, sessionId: string): FixtureStats {
  db.prepare<unknown, [string, string, string]>(
    "INSERT INTO sessions(id, chat_id, user_id) VALUES(?, ?, ?)",
  ).run(sessionId, "chat-bench", "user-bench");

  const TURNS = 20;
  for (let i = 0; i < TURNS; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    const ts = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    db.prepare<unknown, [string, string, string, string, number, string]>(
      `INSERT INTO turns(id, session_id, role, content_redacted, redaction_applied, created_at)
       VALUES(?, ?, ?, ?, ?, ?)`,
    ).run(
      `t-${String(i).padStart(3, "0")}`,
      sessionId,
      role,
      `Turn ${i} content — 한국어 포함 텍스트 내용. 추가 문장으로 현실적인 길이를 맞춘다.`,
      0,
      ts,
    );
  }

  const MEMORY = 50;
  for (let i = 0; i < MEMORY; i++) {
    db.prepare<unknown, [string, string, string, string, number]>(
      `INSERT INTO memory_items(id, session_id, content, provenance, item_type, status, confidence, source_turn_ids, created_at)
       VALUES(?, ?, ?, ?, 'preference', 'active', ?, '[]', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    ).run(
      `m-${String(i).padStart(3, "0")}`,
      sessionId,
      `메모리 항목 ${i}: 사용자 선호 내용 — 구체적인 선호 기술.`,
      "user_stated",
      0.9,
    );
  }

  const facts = Array.from({ length: 5 }, (_, i) => ({ content: `확인된 사실 ${i}` }));
  const tasks = Array.from({ length: 3 }, (_, i) => ({ content: `미결 작업 ${i}` }));
  db.prepare<unknown, [string, string, string | null, string | null, string]>(
    `INSERT INTO memory_summaries(id, session_id, summary_type, facts_json, open_tasks_json, created_at)
     VALUES(?, ?, 'session', ?, ?, ?)`,
  ).run("sum-bench", sessionId, JSON.stringify(facts), JSON.stringify(tasks), "2026-04-01T00:00:00.000Z");

  const JUDGMENTS = 20;
  let jSeq = 0;
  for (let i = 0; i < JUDGMENTS; i++) {
    const jid = `j-bench-${String(++jSeq).padStart(3, "0")}`;
    const proposed = proposeJudgment(
      db,
      {
        kind: "decision",
        statement: `전역 판단 ${i}: 벤치마크 baseline 측정용 판단 항목.`,
        scope: { global: true },
        epistemic_origin: "user_stated",
        confidence: "high",
        importance: 5 - (i % 5),
      },
      { newId: () => jid },
    );
    const approved = approveProposedJudgment(db, { judgment_id: proposed.id, reviewer: "user-bench" });
    const src = recordJudgmentSource(db, { kind: "user_statement", locator: `bench:${jid}` });
    linkJudgmentEvidence(db, { judgment_id: approved.id, source_id: src.id, relation: "supports" });
    commitApprovedJudgment(
      db,
      { judgment_id: approved.id, committer: "user-bench", reason: "bench fixture" },
      { nowIso: () => new Date().toISOString() },
    );
  }

  return { turns: TURNS, memoryItems: MEMORY, summaries: 1, judgments: JUDGMENTS };
}

// --- DB read phase (mirrors compiler.ts internal queries) ---

export interface DbReadResult {
  readonly turns: TurnSlot[];
  readonly memoryItems: MemoryItemSlot[];
  readonly summary: string | undefined;
  readonly judgments: JudgmentItemSlot[];
}

export function runDbRead(db: DbHandle, sessionId: string): DbReadResult {
  const turns = db
    .prepare<TurnSlot, [string]>(
      `SELECT id, role, content_redacted, created_at
       FROM turns
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT 20`,
    )
    .all(sessionId)
    .reverse();

  const memoryItems = db
    .prepare<MemoryItemSlot, [string]>(
      `SELECT id, content, provenance, confidence, status
       FROM memory_items
       WHERE session_id = ? AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 50`,
    )
    .all(sessionId);

  interface SummaryRow {
    readonly facts_json: string | null;
    readonly open_tasks_json: string | null;
    readonly created_at: string;
  }
  const summaryRow = db
    .prepare<SummaryRow, [string]>(
      `SELECT facts_json, open_tasks_json, created_at
       FROM memory_summaries
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(sessionId);

  let summary: string | undefined;
  if (summaryRow) {
    const parts: string[] = [`[요약 기준: ${summaryRow.created_at}]`];
    if (summaryRow.facts_json) {
      try {
        const facts = JSON.parse(summaryRow.facts_json) as Array<{ content: string }>;
        if (facts.length > 0) parts.push(`사실: ${facts.map((f) => f.content).join("; ")}`);
      } catch { /* ignore */ }
    }
    if (summaryRow.open_tasks_json) {
      try {
        const tasks = JSON.parse(summaryRow.open_tasks_json) as Array<{ content: string }>;
        if (tasks.length > 0) parts.push(`미결: ${tasks.map((t) => t.content).join("; ")}`);
      } catch { /* ignore */ }
    }
    summary = parts.join("\n");
  }

  const judgments = db
    .prepare<JudgmentItemSlot, []>(
      `SELECT id, kind, statement, authority_source, confidence
       FROM judgment_items
       WHERE lifecycle_status = 'active'
         AND activation_state = 'eligible'
         AND retention_state = 'normal'
         AND json_extract(scope_json, '$.global') = 1
         AND (valid_from IS NULL OR valid_from <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         AND (valid_until IS NULL OR valid_until > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ORDER BY importance DESC, created_at DESC
       LIMIT 20`,
    )
    .all();

  return { turns, memoryItems, summary, judgments };
}

// --- packing phase ---

export function runPacking(data: DbReadResult, userMessage: string): string {
  const snap = buildContext({
    mode: "replay_mode",
    user_message: userMessage,
    system_identity: "actwyn personal agent",
    recent_turns: data.turns,
    memory_items: data.memoryItems,
    ...(data.judgments.length > 0 ? { judgment_items: data.judgments } : {}),
    ...(data.summary ? { current_session_summary: data.summary } : {}),
  });
  const packed = pack(snap, { total_budget_tokens: 6000 });
  return renderAsMessage(packed);
}

// --- timing helpers ---

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

export interface PhaseStats {
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly iterations: number;
}

function computeStats(timingsMs: number[]): PhaseStats {
  const sorted = [...timingsMs].sort((a, b) => a - b);
  return {
    p50Ms: Math.round(percentile(sorted, 50) * 100) / 100,
    p95Ms: Math.round(percentile(sorted, 95) * 100) / 100,
    maxMs: Math.round(sorted[sorted.length - 1]! * 100) / 100,
    iterations: sorted.length,
  };
}

// --- budget check ---

export interface BudgetViolation {
  readonly phase: string;
  readonly metric: string;
  readonly actualMs: number;
  readonly limitMs: number;
}

export function checkBudgets(
  dbStats: PhaseStats,
  packStats: PhaseStats,
): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  if (dbStats.p95Ms > BUDGET.dbRead.p95Ms) {
    violations.push({ phase: "db_read", metric: "p95", actualMs: dbStats.p95Ms, limitMs: BUDGET.dbRead.p95Ms });
  }
  if (dbStats.maxMs > BUDGET.dbRead.hardCapMs) {
    violations.push({ phase: "db_read", metric: "hard_cap", actualMs: dbStats.maxMs, limitMs: BUDGET.dbRead.hardCapMs });
  }
  if (packStats.p95Ms > BUDGET.packing.p95Ms) {
    violations.push({ phase: "packing", metric: "p95", actualMs: packStats.p95Ms, limitMs: BUDGET.packing.p95Ms });
  }
  return violations;
}

// --- result shape ---

export interface BenchmarkResult {
  readonly meta: {
    readonly bunVersion: string;
    readonly iterations: number;
    readonly fixture: FixtureStats;
    readonly timestamp: string;
  };
  readonly phases: {
    readonly db_read: PhaseStats;
    readonly packing: PhaseStats;
  };
  /** End-to-end compile() timings (replay_mode and resume_mode). Not budget-checked; informational. */
  readonly integration: {
    readonly compile_replay: PhaseStats;
    readonly compile_resume: PhaseStats;
  };
  readonly budgets: {
    readonly db_read: { p95Ms: number; hardCapMs: number };
    readonly packing: { p95Ms: number };
  };
  readonly violations: BudgetViolation[];
  readonly pass: boolean;
}

// --- main ---

export async function runBenchmark(iterations: number): Promise<BenchmarkResult> {
  const workdir = mkdtempSync(join(tmpdir(), "actwyn-bench-"));
  const db = openDatabase({ path: join(workdir, "bench.db"), busyTimeoutMs: 5000 });
  try {
    migrate(db, MIGRATIONS);
    const fixture = seedFixtures(db, SESSION);

    const dbTimings: number[] = [];
    const packTimings: number[] = [];
    const compileReplayTimings: number[] = [];
    const compileResumeTimings: number[] = [];
    const userMessage = "벤치마크 테스트 메시지입니다.";

    for (let i = 0; i < iterations; i++) {
      const dbStart = performance.now();
      const data = runDbRead(db, SESSION);
      dbTimings.push(performance.now() - dbStart);

      const packStart = performance.now();
      runPacking(data, userMessage);
      packTimings.push(performance.now() - packStart);

      // Exercise compile() directly in both modes (integration verification).
      const replayStart = performance.now();
      compile({ db, sessionId: SESSION, mode: "replay_mode", userMessage });
      compileReplayTimings.push(performance.now() - replayStart);

      const resumeStart = performance.now();
      compile({ db, sessionId: SESSION, mode: "resume_mode", userMessage });
      compileResumeTimings.push(performance.now() - resumeStart);
    }

    const dbStats = computeStats(dbTimings);
    const packStats = computeStats(packTimings);
    const violations = checkBudgets(dbStats, packStats);

    return {
      meta: {
        bunVersion: Bun.version,
        iterations,
        fixture,
        timestamp: new Date().toISOString(),
      },
      phases: { db_read: dbStats, packing: packStats },
      integration: {
        compile_replay: computeStats(compileReplayTimings),
        compile_resume: computeStats(compileResumeTimings),
      },
      budgets: {
        db_read: { p95Ms: BUDGET.dbRead.p95Ms, hardCapMs: BUDGET.dbRead.hardCapMs },
        packing: { p95Ms: BUDGET.packing.p95Ms },
      },
      violations,
      pass: violations.length === 0,
    };
  } finally {
    db.close();
    rmSync(workdir, { recursive: true, force: true });
  }
}

function formatTable(result: BenchmarkResult): string {
  const { phases, budgets, violations, meta, integration } = result;
  const pass = (v: boolean) => (v ? "PASS" : "FAIL");
  const dbP95ok = phases.db_read.p95Ms <= budgets.db_read.p95Ms;
  const dbMaxOk = phases.db_read.maxMs <= budgets.db_read.hardCapMs;
  const packP95ok = phases.packing.p95Ms <= budgets.packing.p95Ms;

  const lines: string[] = [
    `Context Compiler Benchmark — ${meta.timestamp}`,
    `Bun ${meta.bunVersion} · ${meta.iterations} iterations`,
    `Fixture: ${meta.fixture.turns} turns, ${meta.fixture.memoryItems} memory items, ${meta.fixture.summaries} summary, ${meta.fixture.judgments} judgments`,
    "",
    "Phase              p50      p95      max      budget-p95  budget-cap  verdict",
    "────────────────────────────────────────────────────────────────────────────",
    `db_read            ${phases.db_read.p50Ms.toFixed(2).padStart(6)}ms  ${phases.db_read.p95Ms.toFixed(2).padStart(6)}ms  ${phases.db_read.maxMs.toFixed(2).padStart(6)}ms  ${String(budgets.db_read.p95Ms).padStart(6)}ms      ${String(budgets.db_read.hardCapMs).padStart(6)}ms  ${pass(dbP95ok && dbMaxOk)}`,
    `packing            ${phases.packing.p50Ms.toFixed(2).padStart(6)}ms  ${phases.packing.p95Ms.toFixed(2).padStart(6)}ms  ${phases.packing.maxMs.toFixed(2).padStart(6)}ms  ${String(budgets.packing.p95Ms).padStart(6)}ms      ${"n/a".padStart(6)}      ${pass(packP95ok)}`,
    "",
    "Integration (compile() end-to-end — informational, not budget-checked):",
    `compile replay_mode ${integration.compile_replay.p50Ms.toFixed(2).padStart(6)}ms  ${integration.compile_replay.p95Ms.toFixed(2).padStart(6)}ms  ${integration.compile_replay.maxMs.toFixed(2).padStart(6)}ms`,
    `compile resume_mode ${integration.compile_resume.p50Ms.toFixed(2).padStart(6)}ms  ${integration.compile_resume.p95Ms.toFixed(2).padStart(6)}ms  ${integration.compile_resume.maxMs.toFixed(2).padStart(6)}ms`,
    "",
  ];

  if (violations.length === 0) {
    lines.push("Result: ALL CLEAR — all ADR-0014 P4 budgets met.");
  } else {
    lines.push(`Result: BUDGET EXCEEDED — ${violations.length} violation(s):`);
    for (const v of violations) {
      lines.push(`  [${v.phase}] ${v.metric}: ${v.actualMs}ms > limit ${v.limitMs}ms`);
    }
  }
  return lines.join("\n");
}

// Only run as entry point (not when imported in tests).
if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const result = await runBenchmark(args.iterations);

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(formatTable(result) + "\n");
  }

  process.exit(result.pass ? 0 : 1);
}
