// Phase 1B.2 — Active judgment slot in context builder.

import { describe, test, expect } from "bun:test";
import { buildContext, type JudgmentItemSlot } from "../../src/context/builder.ts";

const baseInput = {
  mode: "replay_mode" as const,
  user_message: "테스트 메시지",
  system_identity: "actwyn",
};

function makeJudgment(overrides: Partial<JudgmentItemSlot> = {}): JudgmentItemSlot {
  return {
    id: "j-1",
    kind: "decision",
    statement: "SQLite를 canonical state store로 사용한다",
    authority_source: "user_confirmed",
    confidence: "high",
    ...overrides,
  };
}

describe("Phase 1B.2 — judgment_active slot", () => {
  test("no judgment_items → no judgment_active slot", () => {
    const snap = buildContext(baseInput);
    const keys = snap.slots.map((s) => s.key);
    expect(keys).not.toContain("judgment_active");
  });

  test("active judgment items produce a judgment_active slot", () => {
    const snap = buildContext({
      ...baseInput,
      judgment_items: [makeJudgment()],
    });
    const slot = snap.slots.find((s) => s.key === "judgment_active");
    expect(slot).toBeDefined();
    expect(slot!.text).toContain("decision");
    expect(slot!.text).toContain("user_confirmed");
    expect(slot!.text).toContain("SQLite를 canonical state store로 사용한다");
  });

  test("judgment_active slot is droppable (budget pressure may drop it)", () => {
    const snap = buildContext({
      ...baseInput,
      judgment_items: [makeJudgment()],
    });
    const slot = snap.slots.find((s) => s.key === "judgment_active")!;
    expect(slot.droppable).toBe(true);
  });

  test("judgment_active priority (600) sits between memory_user_stated (700) and recent_turns (500)", () => {
    const snap = buildContext({
      ...baseInput,
      judgment_items: [makeJudgment()],
      memory_items: [{ id: "m-1", content: "선호사항", provenance: "user_stated", confidence: 0.9, status: "active" }],
      recent_turns: [{ id: "t-1", role: "user", content_redacted: "이전 발언", created_at: "2026-04-28T00:00:00.000Z" }],
    });

    const byKey = Object.fromEntries(snap.slots.map((s) => [s.key, s.priority]));
    const userStated = byKey["memory_user_stated"] ?? 0;
    const judgment = byKey["judgment_active"] ?? 0;
    const recent = byKey["recent_turns"] ?? 0;

    expect(userStated).toBeGreaterThan(judgment);
    expect(judgment).toBeGreaterThan(recent);
  });

  test("skipJudgments=true (summary_generation) produces no judgment_active slot", () => {
    const snap = buildContext({
      ...baseInput,
      judgment_items: [makeJudgment()],
      // Phase 1B.2: builder itself accepts the data — the worker passes [] when skipJudgments.
      // This test verifies that passing an empty array produces no slot.
    });
    // Pass empty array to simulate skipJudgments behaviour at call site.
    const snapEmpty = buildContext({ ...baseInput, judgment_items: [] });
    const keys = snapEmpty.slots.map((s) => s.key);
    expect(keys).not.toContain("judgment_active");
  });

  test("multiple judgment items all appear in the slot text", () => {
    const items: JudgmentItemSlot[] = [
      makeJudgment({ id: "j-1", kind: "decision", statement: "첫 번째 판단" }),
      makeJudgment({ id: "j-2", kind: "fact", statement: "두 번째 판단", authority_source: "none" }),
    ];
    const snap = buildContext({ ...baseInput, judgment_items: items });
    const slot = snap.slots.find((s) => s.key === "judgment_active")!;
    expect(slot.text).toContain("첫 번째 판단");
    expect(slot.text).toContain("두 번째 판단");
  });
});
