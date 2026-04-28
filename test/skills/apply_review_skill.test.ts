import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SKILLS_DIR = join(import.meta.dir, "..", "..", ".codex", "skills");

function skillFiles(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(SKILLS_DIR, entry.name, "SKILL.md"))
    .sort();
}

function skillContent(name: string): string {
  return readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8");
}

describe("local Codex skills", () => {
  test("all repo-local skills are covered by the compatibility scan", () => {
    const names = skillFiles().map((file) => file.split("/").at(-2));
    expect(names).toEqual([
      "apply-review",
      "codex-loop",
      "dev-cycle",
      "sitrep",
      "verify",
    ]);
  });

  test("use Codex-native planning/editing primitives where they perform edits", () => {
    expect(skillContent("apply-review")).toContain("update_plan");
    expect(skillContent("apply-review")).toContain("apply_patch");
    expect(skillContent("dev-cycle")).toContain("update_plan");
    expect(skillContent("dev-cycle")).toContain("apply_patch");
    expect(skillContent("verify")).toContain("update_plan");
    expect(skillContent("verify")).toContain("apply_patch");
  });

  test("do not reference unavailable Claude Code tool names or workflow hooks", () => {
    const forbiddenStrings = [
      "TodoWrite",
      "general-purpose",
      ".claude",
      "CLAUDE.md",
      "codex:rescue",
      "codex:review",
      "codex:adversarial-review",
      "/verify",
      "/compact",
      "Claude 실행",
      "Claude가",
      "Claude에게",
    ];

    for (const file of skillFiles()) {
      const content = readFileSync(file, "utf8");
      for (const term of forbiddenStrings) {
        expect(content).not.toContain(term);
      }

      expect(content).not.toMatch(/\bClaude\b/);
      expect(content).not.toMatch(/`Edit`/);
      expect(content).not.toMatch(/`Explore`/);
    }
  });

  test("codex-loop is self-contained and uses GitHub-native waiting", () => {
    const content = skillContent("codex-loop");
    expect(content).toContain("gh pr checks");
    expect(content).toContain("GitHub app");
    expect(content).toContain("foreground");
  });

  test("sitrep follows the repo agent read-order constraints", () => {
    const content = skillContent("sitrep");
    expect(content).toContain("AGENTS.md");
    expect(content).toContain("docs/ARCHITECTURE.md");
    expect(content).toContain("긴 P0 설계 문서");
  });
});
