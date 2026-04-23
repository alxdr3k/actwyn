import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findViolations,
  walkTsFiles,
  FORBIDDEN_PATTERNS,
} from "../scripts/check-single-redactor.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-single-redactor.ts");
const ALLOWED = new Set<string>(["src/observability/redact.ts"]);

describe("check-single-redactor — script level", () => {
  test("passes on the real src/ tree", () => {
    const result = spawnSync("bun", [SCRIPT], {
      encoding: "utf8",
      cwd: REPO_ROOT,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("single-redactor invariant OK");
  });
});

describe("check-single-redactor — unit (findViolations)", () => {
  let workdir: string;

  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), "actwyn-single-redactor-"));
    mkdirSync(join(workdir, "src", "observability"), { recursive: true });
    writeFileSync(
      join(workdir, "src", "observability", "redact.ts"),
      '// the allowed module — may use [REDACTED:foo]\n',
    );
  });

  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  test("no violations when other files are clean", () => {
    const clean = join(workdir, "src", "good.ts");
    writeFileSync(clean, "export const X = 1;\n");
    try {
      const files = walkTsFiles(join(workdir, "src"));
      expect(findViolations(workdir, files, ALLOWED)).toEqual([]);
    } finally {
      rmSync(clean);
    }
  });

  test("detects [REDACTED:*] placeholder outside the allowed module", () => {
    const bad = join(workdir, "src", "bad_placeholder.ts");
    writeFileSync(bad, 'export const TAG = "[REDACTED:somewhere_else]";\n');
    try {
      const files = walkTsFiles(join(workdir, "src"));
      const violations = findViolations(workdir, files, ALLOWED);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]!.file).toBe("src/bad_placeholder.ts");
      expect(violations[0]!.pattern).toContain("[REDACTED:*]");
    } finally {
      rmSync(bad);
    }
  });

  test("detects inline AWS key regex in another module", () => {
    const bad = join(workdir, "src", "bad_aws.ts");
    writeFileSync(bad, "const r = /\\b(?:AKIA|ASIA)[0-9A-Z]{16}/g;\n");
    try {
      const files = walkTsFiles(join(workdir, "src"));
      const violations = findViolations(workdir, files, ALLOWED);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]!.pattern).toContain("AKIA");
    } finally {
      rmSync(bad);
    }
  });

  test("allowed module is exempt", () => {
    // Add a forbidden pattern to the allowed module and verify no
    // violation is reported.
    const allowed = join(workdir, "src", "observability", "redact.ts");
    const original = Bun.file(allowed).text();
    return original.then((orig) => {
      writeFileSync(
        allowed,
        orig + '\nexport const X = "[REDACTED:exact_secret]";\n',
      );
      try {
        const files = walkTsFiles(join(workdir, "src"));
        const violations = findViolations(workdir, files, ALLOWED);
        const offenders = violations.filter((v) => v.file === "src/observability/redact.ts");
        expect(offenders).toEqual([]);
      } finally {
        writeFileSync(allowed, orig);
      }
    });
  });
});

describe("check-single-redactor — pattern coverage", () => {
  test("each forbidden pattern has a name and a regex that matches an example", () => {
    const samples: Record<string, string> = {
      "[REDACTED:*] placeholder literal": 'x = "[REDACTED:jwt]";',
      "AKIA / ASIA AWS key pattern": "/\\b(?:AKIA|ASIA)/",
      "Bearer-token regex": "/\\bBearer\\s+/",
      "sk-ant prefix regex": "'sk-ant-api'",
    };
    for (const p of FORBIDDEN_PATTERNS) {
      const sample = samples[p.name];
      expect(sample, `missing sample for pattern ${p.name}`).toBeDefined();
      expect(p.re.test(sample!)).toBe(true);
    }
  });
});
