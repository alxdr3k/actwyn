// Judgment System Phase 1A.1/1A.2 — pure-TS validator coverage.

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
  validateEpistemicOrigin,
  validateImportance,
  validateJsonValue,
  validateKind,
  validateScopeJson,
  validateScopeObject,
  validateStatement,
  validateStringArray,
  validateStringArraySerialization,
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

// Phase 1A.2 additions

describe("validateKind", () => {
  test("accepts all valid kinds", () => {
    for (const k of ["fact", "preference", "decision", "current_state", "procedure", "caution"]) {
      expect(validateKind(k).ok).toBe(true);
    }
  });

  test("rejects unknown kind", () => {
    expect(validateKind("banana").ok).toBe(false);
    expect(validateKind("").ok).toBe(false);
    expect(validateKind(null).ok).toBe(false);
  });
});

describe("validateEpistemicOrigin", () => {
  test("accepts all valid origins", () => {
    for (const o of [
      "observed",
      "user_stated",
      "user_confirmed",
      "inferred",
      "assistant_generated",
      "tool_output",
    ]) {
      expect(validateEpistemicOrigin(o).ok).toBe(true);
    }
  });

  test("rejects unknown origin", () => {
    expect(validateEpistemicOrigin("rumor").ok).toBe(false);
    expect(validateEpistemicOrigin(42).ok).toBe(false);
  });
});

describe("validateScopeObject", () => {
  test("accepts plain object", () => {
    expect(validateScopeObject({ project: "actwyn" }).ok).toBe(true);
  });

  test("accepts Object.create(null)", () => {
    expect(validateScopeObject(Object.create(null)).ok).toBe(true);
  });

  test("rejects null", () => {
    expect(validateScopeObject(null).ok).toBe(false);
  });

  test("rejects array", () => {
    expect(validateScopeObject([]).ok).toBe(false);
    expect(validateScopeObject(["a"]).ok).toBe(false);
  });

  test("rejects primitive", () => {
    expect(validateScopeObject("string").ok).toBe(false);
    expect(validateScopeObject(42).ok).toBe(false);
    expect(validateScopeObject(true).ok).toBe(false);
  });

  test("rejects Date instance (class instance, not plain object)", () => {
    // new Date() serializes to a string scalar, not an object — would corrupt scope_json shape.
    expect(validateScopeObject(new Date()).ok).toBe(false);
  });

  test("rejects Map instance", () => {
    expect(validateScopeObject(new Map()).ok).toBe(false);
  });

  test("rejects circular / unserializable object", () => {
    const circ: Record<string, unknown> = {};
    circ["self"] = circ;
    expect(validateScopeObject(circ).ok).toBe(false);
  });

  test("rejects object whose toJSON() returns undefined", () => {
    // JSON.stringify returns undefined — not storable as scope_json.
    const undefinedJson = { toJSON() { return undefined; } };
    expect(validateScopeObject(undefinedJson).ok).toBe(false);
  });

  test("rejects object whose toJSON() returns a scalar string", () => {
    // Scalar toJSON corrupts the expected object shape in scope_json.
    const scalarJson = { toJSON() { return "scalar"; } };
    expect(validateScopeObject(scalarJson).ok).toBe(false);
  });
});

describe("validateStringArray", () => {
  test("accepts array of non-empty strings", () => {
    expect(validateStringArray(["a", "b"], "ids").ok).toBe(true);
    expect(validateStringArray([], "ids").ok).toBe(true);
  });

  test("rejects non-array", () => {
    expect(validateStringArray("a", "ids").ok).toBe(false);
    expect(validateStringArray(null, "ids").ok).toBe(false);
  });

  test("rejects array with empty string element", () => {
    expect(validateStringArray(["a", ""], "ids").ok).toBe(false);
  });

  test("rejects array with non-string element", () => {
    expect(validateStringArray([1, 2], "ids").ok).toBe(false);
    expect(validateStringArray([null], "ids").ok).toBe(false);
  });
});

describe("validateStringArraySerialization", () => {
  test("accepts normal string array", () => {
    expect(validateStringArraySerialization(["a", "b"], "ids").ok).toBe(true);
    expect(validateStringArraySerialization([], "ids").ok).toBe(true);
  });

  test("rejects array whose toJSON() returns undefined", () => {
    const arr = Object.assign(["s1"], { toJSON() { return undefined; } });
    expect(validateStringArraySerialization(arr, "ids").ok).toBe(false);
  });

  test("rejects array whose toJSON() returns a scalar", () => {
    const arr = Object.assign(["s1"], { toJSON() { return "scalar"; } });
    expect(validateStringArraySerialization(arr, "ids").ok).toBe(false);
  });

  test("rejects array whose toJSON() returns an object (not array)", () => {
    const arr = Object.assign(["s1"], { toJSON() { return { hijacked: true }; } });
    expect(validateStringArraySerialization(arr, "ids").ok).toBe(false);
  });

  test("rejects array whose toJSON() returns a non-string-element array", () => {
    // toJSON returning [1, 2] passes the Array.isArray check but would store
    // non-string IDs — re-validate element types on the reparsed array.
    const arr = Object.assign(["s1"], { toJSON() { return [1, 2]; } });
    expect(validateStringArraySerialization(arr, "ids").ok).toBe(false);
  });
});

describe("validateJsonValue", () => {
  test("accepts plain object", () => {
    expect(validateJsonValue({ a: 1 }).ok).toBe(true);
  });

  test("accepts array", () => {
    expect(validateJsonValue(["x"]).ok).toBe(true);
    expect(validateJsonValue([]).ok).toBe(true);
  });

  test("rejects null", () => {
    expect(validateJsonValue(null).ok).toBe(false);
  });

  test("rejects primitives", () => {
    expect(validateJsonValue("str").ok).toBe(false);
    expect(validateJsonValue(42).ok).toBe(false);
    expect(validateJsonValue(true).ok).toBe(false);
  });

  test("rejects unserializable object", () => {
    const circ: Record<string, unknown> = {};
    circ["self"] = circ;
    expect(validateJsonValue(circ).ok).toBe(false);
  });

  test("rejects Date instance (serializes to string scalar, not object)", () => {
    // new Date() → JSON.stringify → '"2024-..."' → JSON.parse → string scalar
    expect(validateJsonValue(new Date()).ok).toBe(false);
  });

  test("rejects object whose toJSON() returns a scalar", () => {
    // Objects with toJSON returning a primitive corrupt the stored column shape.
    const scalarJson = { toJSON() { return "scalar"; } };
    expect(validateJsonValue(scalarJson).ok).toBe(false);
  });

  test("rejects object whose toJSON() returns undefined", () => {
    // JSON.stringify returns undefined — JSON.parse would throw without this guard.
    const undefinedJson = { toJSON() { return undefined; } };
    expect(validateJsonValue(undefinedJson).ok).toBe(false);
  });
});
