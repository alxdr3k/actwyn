import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkThinDocs,
  countLines,
  FORBIDDEN_PATTERNS,
  ROLE_NOTE,
} from "../scripts/check-thin-docs.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-thin-docs.ts");

describe("check-thin-docs — script level", () => {
  test("passes on the real thin current-state docs", () => {
    const result = spawnSync("bun", [SCRIPT], {
      encoding: "utf8",
      cwd: REPO_ROOT,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("thin current-state docs OK");
  });
});

describe("check-thin-docs — unit", () => {
  let workdir: string;

  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), "actwyn-thin-docs-"));
    mkdirSync(join(workdir, "docs"), { recursive: true });
  });

  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  test("countLines ignores the final trailing newline", () => {
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("")).toBe(0);
  });

  test("line budget violations are reported", () => {
    writeFileSync(
      join(workdir, "docs", "TOO_LONG.md"),
      `# Doc\n\n${ROLE_NOTE}\n\none\ntwo\nthree\n`,
    );

    const violations = checkThinDocs(workdir, [
      { path: "docs/TOO_LONG.md", maxLines: 4 },
    ]);

    expect(violations.some((v) => v.rule === "line-budget")).toBe(true);
  });

  test("missing role note is reported", () => {
    writeFileSync(join(workdir, "docs", "NO_NOTE.md"), "# Doc\n\nCurrent state.\n");

    const violations = checkThinDocs(workdir, [
      { path: "docs/NO_NOTE.md", maxLines: 20 },
    ]);

    expect(violations.some((v) => v.rule === "missing-role-note")).toBe(true);
  });

  test("phase history prose is reported", () => {
    writeFileSync(
      join(workdir, "docs", "LOG.md"),
      `# Doc\n\n${ROLE_NOTE}\n\nPhase 1C.2 landed a new detailed surface.\n`,
    );

    const violations = checkThinDocs(workdir, [
      { path: "docs/LOG.md", maxLines: 20 },
    ]);

    expect(violations.some((v) => v.rule === "phase-history prose")).toBe(true);
  });

  test("each forbidden pattern has a sample", () => {
    const samples: Record<string, string> = {
      "implementation-log heading": "## What is implemented",
      "phase-history prose": "Phase 1C.2 landed a detailed implementation.",
      "operation-count inventory": "It supports eleven operations:",
      "test-case dump": "malformed denormalized array elements",
    };

    for (const pattern of FORBIDDEN_PATTERNS) {
      const sample = samples[pattern.name];
      expect(sample, `missing sample for pattern ${pattern.name}`).toBeDefined();
      expect(pattern.re.test(sample!)).toBe(true);
    }
  });
});
