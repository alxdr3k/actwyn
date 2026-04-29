import { describe, expect, test } from "bun:test";

import {
  mayPersistAsMemoryItem,
  mayPromoteToLongTerm,
  mayProposeJudgment,
} from "../../src/memory/provenance.ts";

describe("memory provenance gates", () => {
  test("memory persistence gate keeps the existing preference provenance rule", () => {
    expect(mayPersistAsMemoryItem("user_stated", "preference")).toBe(true);
    expect(mayPersistAsMemoryItem("user_confirmed", "preference")).toBe(true);
    expect(mayPersistAsMemoryItem("inferred", "preference")).toBe(false);
    expect(mayPersistAsMemoryItem("assistant_generated", "preference")).toBe(false);
    expect(mayPersistAsMemoryItem("inferred", "fact")).toBe(true);
  });

  test("judgment proposal gate is separate from memory persistence", () => {
    expect(mayProposeJudgment("inferred", "preference")).toBe(true);
    expect(mayProposeJudgment("assistant_generated", "decision")).toBe(true);
    expect(mayProposeJudgment("user_stated", "unknown")).toBe(false);
  });

  test("legacy promotion helper delegates to memory persistence semantics", () => {
    expect(mayPromoteToLongTerm("user_stated", "preference")).toBe(true);
    expect(mayPromoteToLongTerm("inferred", "preference")).toBe(false);
  });
});
