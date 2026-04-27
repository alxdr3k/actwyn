// Judgment System Phase 1A.1 — pure-TS validator coverage.

import { describe, expect, test } from "bun:test";

import {
  isActivationStateP05,
  isApprovalState,
  isAuthoritySourceP05,
  isConfidence,
  isDecayPolicyP05,
  isEpistemicOrigin,
  isJudgmentKind,
  isLifecycleStatus,
  isProcedureSubtype,
  isRetentionState,
  validateConfidenceLabel,
  validateImportance,
  validateScopeJson,
  validateStatement,
} from "../../src/judgment/validators.ts";

describe("type guards", () => {
  test("isJudgmentKind", () => {
    expect(isJudgmentKind("fact")).toBe(true);
    expect(isJudgmentKind("banana")).toBe(false);
  });

  test("isEpistemicOrigin", () => {
    expect(isEpistemicOrigin("observed")).toBe(true);
    expect(isEpistemicOrigin("rumor")).toBe(false);
  });

  test("isAuthoritySourceP05", () => {
    expect(isAuthoritySourceP05("none")).toBe(true);
    expect(isAuthoritySourceP05("user_confirmed")).toBe(true);
    expect(isAuthoritySourceP05("maintainer_approved")).toBe(false);
  });

  test("isApprovalState", () => {
    expect(isApprovalState("pending")).toBe(true);
    expect(isApprovalState("denied")).toBe(false);
  });

  test("isLifecycleStatus", () => {
    expect(isLifecycleStatus("active")).toBe(true);
    expect(isLifecycleStatus("frozen")).toBe(false);
  });

  test("isActivationStateP05", () => {
    expect(isActivationStateP05("eligible")).toBe(true);
    expect(isActivationStateP05("dormant")).toBe(false);
  });

  test("isRetentionState", () => {
    expect(isRetentionState("normal")).toBe(true);
    expect(isRetentionState("shredded")).toBe(false);
  });

  test("isConfidence", () => {
    expect(isConfidence("medium")).toBe(true);
    expect(isConfidence("definite")).toBe(false);
  });

  test("isDecayPolicyP05", () => {
    expect(isDecayPolicyP05("supersede_only")).toBe(true);
    expect(isDecayPolicyP05("time_decay")).toBe(false);
  });

  test("isProcedureSubtype", () => {
    expect(isProcedureSubtype("skill")).toBe(true);
    expect(isProcedureSubtype("magic")).toBe(false);
  });
});

describe("validateStatement", () => {
  test("rejects empty string", () => {
    expect(validateStatement("")).toEqual({
      ok: false,
      reason: expect.any(String),
    });
  });

  test("rejects whitespace-only", () => {
    const r = validateStatement("   ");
    expect(r.ok).toBe(false);
  });

  test("accepts non-empty string", () => {
    expect(validateStatement("hi")).toEqual({ ok: true });
  });

  test("rejects non-string", () => {
    expect(validateStatement(42).ok).toBe(false);
  });
});

describe("validateScopeJson", () => {
  test("accepts a plain object", () => {
    expect(validateScopeJson('{"project":"actwyn"}')).toEqual({ ok: true });
  });

  test("rejects an array", () => {
    expect(validateScopeJson("[]").ok).toBe(false);
  });

  test("rejects null", () => {
    expect(validateScopeJson("null").ok).toBe(false);
  });

  test("rejects malformed JSON", () => {
    expect(validateScopeJson("not json").ok).toBe(false);
  });

  test("rejects a primitive", () => {
    expect(validateScopeJson('"just a string"').ok).toBe(false);
    expect(validateScopeJson("123").ok).toBe(false);
  });
});

describe("validateImportance", () => {
  test("rejects 0", () => {
    expect(validateImportance(0).ok).toBe(false);
  });

  test("rejects 6", () => {
    expect(validateImportance(6).ok).toBe(false);
  });

  test("accepts 3", () => {
    expect(validateImportance(3)).toEqual({ ok: true });
  });

  test("rejects non-integer", () => {
    expect(validateImportance(2.5).ok).toBe(false);
  });

  test("rejects non-number", () => {
    expect(validateImportance("3").ok).toBe(false);
  });
});

describe("validateConfidenceLabel", () => {
  test("accepts low/medium/high", () => {
    expect(validateConfidenceLabel("low")).toEqual({ ok: true });
    expect(validateConfidenceLabel("medium")).toEqual({ ok: true });
    expect(validateConfidenceLabel("high")).toEqual({ ok: true });
  });

  test("rejects definite", () => {
    expect(validateConfidenceLabel("definite").ok).toBe(false);
  });
});
