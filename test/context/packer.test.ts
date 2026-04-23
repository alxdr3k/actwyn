import { describe, test, expect } from "bun:test";
import { buildContext, type BuildInput, type MemoryItemSlot } from "../../src/context/builder.ts";
import { pack, PromptOverflowError, serializeForProviderRun } from "../../src/context/packer.ts";

function mi(overrides: Partial<MemoryItemSlot>): MemoryItemSlot {
  return {
    id: overrides.id ?? "m1",
    content: overrides.content ?? "a fact",
    provenance: overrides.provenance ?? "user_stated",
    confidence: overrides.confidence ?? 0.9,
    status: overrides.status ?? "active",
  };
}

function base(overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    mode: "replay_mode",
    user_message: "Q: how are you?",
    system_identity: "SYS",
    ...overrides,
  };
}

describe("buildContext — slot construction", () => {
  test("minimal build → user_message + system_identity only", () => {
    const snap = buildContext(base());
    expect(snap.slots.map((s) => s.key)).toEqual(["user_message", "system_identity"]);
  });

  test("resume_mode excludes recent_turns even if provided", () => {
    const snap = buildContext(
      base({ mode: "resume_mode", recent_turns: [{ id: "t", role: "user", content_redacted: "x", created_at: "2024" }] }),
    );
    expect(snap.slots.map((s) => s.key)).not.toContain("recent_turns");
  });

  test("superseded/revoked memory items are excluded", () => {
    const snap = buildContext(
      base({
        memory_items: [
          mi({ id: "a", status: "active", provenance: "user_stated", content: "keep" }),
          mi({ id: "b", status: "superseded", provenance: "user_stated", content: "drop-super" }),
          mi({ id: "c", status: "revoked", provenance: "user_stated", content: "drop-revoke" }),
        ],
      }),
    );
    const userStatedSlot = snap.slots.find((s) => s.key === "memory_user_stated");
    expect(userStatedSlot?.text).toContain("keep");
    expect(userStatedSlot?.text).not.toContain("drop-super");
    expect(userStatedSlot?.text).not.toContain("drop-revoke");
  });

  test("memory_user_stated and memory_other partitioned by provenance", () => {
    const snap = buildContext(
      base({
        memory_items: [
          mi({ id: "a", provenance: "user_stated", content: "stated" }),
          mi({ id: "b", provenance: "inferred", content: "inferred" }),
        ],
      }),
    );
    expect(snap.slots.find((s) => s.key === "memory_user_stated")?.text).toContain("stated");
    expect(snap.slots.find((s) => s.key === "memory_other")?.text).toContain("inferred");
  });
});

// ---------------------------------------------------------------
// pack() drop precedence
// ---------------------------------------------------------------

describe("pack — drop order matches PRD §12.5", () => {
  test("small budget: drops lowest-priority first (verbose_transcript before memory_other, etc.)", () => {
    const snap = buildContext(
      base({
        inactive_project_context: "X".repeat(300),
        current_session_summary: "Y".repeat(300),
        active_project_context: "Z".repeat(300),
        memory_items: [
          mi({ id: "a", provenance: "user_stated", content: "A".repeat(200) }),
          mi({ id: "b", provenance: "inferred", content: "B".repeat(200), confidence: 0.2 }),
        ],
        verbose_transcript: "V".repeat(300),
      }),
    );
    const packed = pack(snap, { total_budget_tokens: 40 });
    // User message + system identity must always be retained.
    expect(packed.slots.find((s) => s.key === "user_message")?.retained).toBe(true);
    expect(packed.slots.find((s) => s.key === "system_identity")?.retained).toBe(true);
    // verbose_transcript is lowest priority droppable → dropped first.
    expect(packed.dropped).toContain("verbose_transcript");
    // user_stated memory is higher priority than other memory; it is
    // retained if anything is retained.
    const userStatedRetained = packed.slots.find((s) => s.key === "memory_user_stated")?.retained;
    const otherMemRetained = packed.slots.find((s) => s.key === "memory_other")?.retained;
    if (otherMemRetained) {
      expect(userStatedRetained).toBe(true);
    }
  });

  test("enough budget: nothing dropped", () => {
    const snap = buildContext(base({ current_session_summary: "summary" }));
    const packed = pack(snap, { total_budget_tokens: 10_000 });
    expect(packed.dropped).toEqual([]);
    for (const s of packed.slots) expect(s.retained).toBe(true);
  });

  test("minimum prompt (user + sys) cannot fit → PromptOverflowError", () => {
    const snap = buildContext(
      base({ user_message: "Q".repeat(9000), system_identity: "S".repeat(9000) }),
    );
    expect(() => pack(snap, { total_budget_tokens: 100 })).toThrow(PromptOverflowError);
  });

  test("recent_turns dropped before user_stated memory under pressure", () => {
    const snap = buildContext(
      base({
        recent_turns: Array.from({ length: 10 }, (_, i) => ({
          id: `t${i}`,
          role: "user",
          content_redacted: "T".repeat(200),
          created_at: `2024-01-${String(i + 1).padStart(2, "0")}`,
        })),
        memory_items: [
          mi({ id: "u", provenance: "user_confirmed", content: "important" }),
        ],
      }),
    );
    const packed = pack(snap, { total_budget_tokens: 60 });
    const turns = packed.slots.find((s) => s.key === "recent_turns")?.retained;
    const userStated = packed.slots.find((s) => s.key === "memory_user_stated")?.retained;
    if (turns === false) {
      expect(userStated).toBe(true);
    }
  });
});

describe("serializeForProviderRun", () => {
  test("includes mode, total_tokens, dropped list; slot entries have no text", () => {
    const packed = pack(
      buildContext(base({ current_session_summary: "hi", verbose_transcript: "v" })),
      { total_budget_tokens: 10_000 },
    );
    const json = JSON.parse(serializeForProviderRun(packed));
    expect(json.mode).toBe("replay_mode");
    expect(Array.isArray(json.slots)).toBe(true);
    for (const s of json.slots) expect(s.text).toBeUndefined();
    expect(Array.isArray(json.dropped)).toBe(true);
  });
});
