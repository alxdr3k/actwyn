import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APPLY_REVIEW_SKILL = join(
  import.meta.dir,
  "..",
  "..",
  ".codex",
  "skills",
  "apply-review",
  "SKILL.md",
);

describe("apply-review Codex skill", () => {
  const content = readFileSync(APPLY_REVIEW_SKILL, "utf8");

  test("uses Codex-native planning and editing tools", () => {
    expect(content).toContain("update_plan");
    expect(content).toContain("apply_patch");
  });

  test("does not reference unavailable Claude Code tool names", () => {
    const forbiddenStrings = [
      "TodoWrite",
      "general-purpose",
      ".claude/rules",
      "CLAUDE.md",
    ];

    for (const term of forbiddenStrings) {
      expect(content).not.toContain(term);
    }

    expect(content).not.toMatch(/\bEdit\b/);
    expect(content).not.toMatch(/\bExplore\b/);
  });
});
