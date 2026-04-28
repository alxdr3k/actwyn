#!/usr/bin/env bun
// Keeps the thin current-state docs as indexes instead of
// implementation logs. The goal is not perfect prose linting; it is a
// cheap guard against the failure modes that made these docs grow.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ThinDocRule {
  readonly path: string;
  readonly maxLines: number;
}

export interface ThinDocViolation {
  readonly file: string;
  readonly rule: string;
  readonly message: string;
  readonly line?: number;
  readonly text?: string;
}

export const ROLE_NOTE = "This file is an index, not an implementation log.";

export const THIN_DOCS: readonly ThinDocRule[] = [
  { path: "docs/ARCHITECTURE.md", maxLines: 250 },
  { path: "docs/RUNTIME.md", maxLines: 275 },
  { path: "docs/DATA_MODEL.md", maxLines: 425 },
  { path: "docs/CODE_MAP.md", maxLines: 235 },
  { path: "docs/TESTING.md", maxLines: 210 },
  { path: "docs/OPERATIONS.md", maxLines: 285 },
];

export const FORBIDDEN_PATTERNS: ReadonlyArray<{
  readonly name: string;
  readonly re: RegExp;
  readonly message: string;
}> = [
  {
    name: "implementation-log heading",
    re: /^#{2,3}\s+What is implemented\b/i,
    message: "Replace stale current state instead of adding an implementation inventory section.",
  },
  {
    name: "phase-history prose",
    re: /\bPhase\s+\d+[A-Z]?(?:\.\d+)?(?:[–.-]\d+)?[^.\n]{0,80}\b(?:landed|have landed|has added|added|now also exports|now imports)\b/i,
    message: "Phase history belongs in PRs, issues, ADRs, tests, commits, or generated docs.",
  },
  {
    name: "operation-count inventory",
    re: /\bsupports\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+operations\b/i,
    message: "Thin docs should summarize current surfaces, not enumerate every operation.",
  },
  {
    name: "test-case dump",
    re: /\bmalformed denormalized array elements\b|\bProposal repository insert\b/i,
    message: "Detailed test cases belong in test files, not thin docs.",
  },
];

export function countLines(body: string): number {
  if (body.length === 0) return 0;
  const lines = body.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

export function checkThinDocs(
  root: string,
  rules: readonly ThinDocRule[] = THIN_DOCS,
): ThinDocViolation[] {
  const violations: ThinDocViolation[] = [];

  for (const rule of rules) {
    const fullPath = join(root, rule.path);
    if (!existsSync(fullPath)) {
      violations.push({
        file: rule.path,
        rule: "missing-file",
        message: "Thin doc rule points at a missing file.",
      });
      continue;
    }

    const body = readFileSync(fullPath, "utf8");
    const lineCount = countLines(body);
    if (lineCount > rule.maxLines) {
      violations.push({
        file: rule.path,
        rule: "line-budget",
        message: `Line budget exceeded: ${lineCount}/${rule.maxLines}. Replace stale current-state prose instead of appending history.`,
      });
    }

    if (!body.includes(ROLE_NOTE)) {
      violations.push({
        file: rule.path,
        rule: "missing-role-note",
        message: `Missing role note: "${ROLE_NOTE}"`,
      });
    }

    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.re.test(line)) {
          violations.push({
            file: rule.path,
            rule: pattern.name,
            message: pattern.message,
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }
  }

  return violations;
}

function main(): number {
  const root = join(import.meta.dir, "..");
  const violations = checkThinDocs(root);

  if (violations.length > 0) {
    console.error("Thin current-state docs guard failed.");
    console.error("These docs are indexes, not implementation logs.");
    console.error("Replace current-state summaries; do not append phase history.");
    console.error("");
    for (const violation of violations) {
      const location =
        violation.line === undefined ? violation.file : `${violation.file}:${violation.line}`;
      console.error(`  ${location}  [${violation.rule}]`);
      console.error(`    ${violation.message}`);
      if (violation.text !== undefined) console.error(`    ${violation.text}`);
    }
    return 1;
  }

  console.log("thin current-state docs OK");
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
