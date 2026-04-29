import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import { proposeJudgmentsFromSummary } from "../../src/judgment/summary_proposals.ts";
import type { SummaryOutput } from "../../src/memory/summary.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let db: DbHandle;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-summary-proposals-"));
  db = openDatabase({ path: join(workdir, "test.db"), busyTimeoutMs: 250 });
  migrate(db, MIGRATIONS);
});

afterEach(() => {
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

function summary(overrides: Partial<SummaryOutput> = {}): SummaryOutput {
  return {
    session_id: "sess-1",
    summary_type: "session",
    facts: [{ content: "사용자는 Bun을 선호한다", provenance: "observed", confidence: 0.82 }],
    preferences: [{ content: "짧은 답변을 선호한다", provenance: "inferred", confidence: 0.49 }],
    decisions: [{ content: "SQLite WAL을 사용한다", provenance: "user_confirmed", confidence: 0.91 }],
    open_tasks: [{ content: "acceptance 환경을 준비한다", provenance: "user_stated", confidence: 0.7 }],
    cautions: [{ content: "provider tool 등록은 명시 승인 전 금지", provenance: "assistant_generated", confidence: 0.8 }],
    source_turn_ids: ["turn-1", "turn-2"],
    ...overrides,
  };
}

describe("proposeJudgmentsFromSummary — JDG-1C.2a", () => {
  test("creates proposed judgments for each structured summary item without activation", () => {
    let n = 0;
    const result = proposeJudgmentsFromSummary({
      db,
      summary_id: "sum-1",
      summary: summary(),
    }, {
      newId: () => `judg-${++n}`,
      actor: "summary_generation",
      nowIso: () => "2026-04-29T00:00:00.000Z",
    });

    expect(result.proposed).toBe(5);
    expect(result.skipped).toBe(0);
    expect(result.judgment_ids).toEqual(["judg-1", "judg-2", "judg-3", "judg-4", "judg-5"]);
    expect(result.judgments.map((j) => j.kind)).toEqual([
      "fact",
      "preference",
      "decision",
      "current_state",
      "caution",
    ]);

    const rows = db
      .prepare<{
        id: string;
        kind: string;
        statement: string;
        epistemic_origin: string;
        confidence: string;
        lifecycle_status: string;
        approval_state: string;
        activation_state: string;
        authority_source: string;
        source_ids_json: string | null;
        evidence_ids_json: string | null;
        scope_json: string;
        missing_evidence_json: string;
        review_trigger_json: string;
        observed_at: string | null;
      }, never[]>(
        `SELECT id, kind, statement, epistemic_origin, confidence,
                lifecycle_status, approval_state, activation_state, authority_source,
                source_ids_json, evidence_ids_json, scope_json,
                missing_evidence_json, review_trigger_json, observed_at
         FROM judgment_items ORDER BY id`,
      )
      .all();

    expect(rows.map((r) => r.kind)).toEqual([
      "fact",
      "preference",
      "decision",
      "current_state",
      "caution",
    ]);
    expect(rows.map((r) => r.lifecycle_status)).toEqual([
      "proposed",
      "proposed",
      "proposed",
      "proposed",
      "proposed",
    ]);
    expect(rows.map((r) => r.approval_state)).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(rows.map((r) => r.activation_state)).toEqual([
      "history_only",
      "history_only",
      "history_only",
      "history_only",
      "history_only",
    ]);
    expect(rows.every((r) => r.authority_source === "none")).toBe(true);
    expect(rows.every((r) => r.source_ids_json === null)).toBe(true);
    expect(rows.every((r) => r.evidence_ids_json === null)).toBe(true);
    expect(rows.every((r) => r.observed_at === "2026-04-29T00:00:00.000Z")).toBe(true);

    const factScope = JSON.parse(rows[0]!.scope_json);
    expect(factScope).toEqual({
      global: true,
      source: "summary_generation",
      session_id: "sess-1",
      summary_id: "sum-1",
      summary_type: "session",
      summary_item_type: "fact",
    });
    expect(JSON.parse(rows[0]!.missing_evidence_json).source_turn_ids).toEqual(["turn-1", "turn-2"]);
    expect(JSON.parse(rows[3]!.review_trigger_json).summary_item_type).toBe("open_task");

    const events = db
      .prepare<{ event_type: string; actor: string }, never[]>(
        "SELECT event_type, actor FROM judgment_events ORDER BY judgment_id",
      )
      .all();
    expect(events.length).toBe(5);
    expect(events.every((e) => e.event_type === "judgment.proposed")).toBe(true);
    expect(events.every((e) => e.actor === "summary_generation")).toBe(true);
  });

  test("skips invalid summary items and continues proposing the valid items", () => {
    let n = 0;
    const result = proposeJudgmentsFromSummary({
      db,
      summary_id: "sum-2",
      summary: summary({
        facts: [
          { content: "", provenance: "observed", confidence: 0.9 },
          { content: "유효한 사실", provenance: "observed", confidence: 0.9 },
        ],
        preferences: [],
        decisions: [],
        open_tasks: [],
        cautions: [],
      }),
    }, {
      newId: () => `judg-${++n}`,
    });

    expect(result.proposed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors[0]!.item_type).toBe("fact");

    const count = db
      .prepare<{ n: number }, never[]>("SELECT COUNT(*) AS n FROM judgment_items")
      .get()!.n;
    expect(count).toBe(1);
  });
});
