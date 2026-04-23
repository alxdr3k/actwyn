#!/usr/bin/env bun
// Enforces HLD §13.1 invariant: only `src/observability/redact.ts`
// is allowed to implement redaction. Every other module routes
// through `createRedactor(...).apply(...)`.
//
// We scan src/ for files that look like they ARE doing redaction
// (regex patterns for secrets, inline `[REDACTED:*]` placeholders)
// and fail if any match outside the allowed module.
//
// This is a cheap grep — it is not perfect, but it catches the
// common failure modes: someone pasting a secret regex into a new
// file, or sprinkling `[REDACTED:foo]` in other modules.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface Violation {
  readonly file: string;
  readonly pattern: string;
  readonly line: number;
  readonly text: string;
}

// Signals that a file is doing ad-hoc redaction.
export const FORBIDDEN_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "[REDACTED:*] placeholder literal", re: /\[REDACTED:[a-z_]+\]/ },
  { name: "AKIA / ASIA AWS key pattern", re: /\\b\(\?:AKIA\|ASIA\)/ },
  { name: "Bearer-token regex", re: /\\bBearer\\s/ },
  { name: "sk-ant prefix regex", re: /sk-ant-/ },
];

export function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkTsFiles(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

export function findViolations(
  root: string,
  files: readonly string[],
  allowed: ReadonlySet<string>,
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const rel = relative(root, file).split(sep).join("/");
    if (allowed.has(rel)) continue;
    const body = readFileSync(file, "utf8");
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const p of FORBIDDEN_PATTERNS) {
        if (p.re.test(line)) {
          violations.push({ file: rel, pattern: p.name, line: i + 1, text: line.trim() });
        }
      }
    }
  }
  return violations;
}

const ALLOWED = new Set<string>(["src/observability/redact.ts"]);

function main(): number {
  const root = join(import.meta.dir, "..");
  const src = join(root, "src");
  const files = walkTsFiles(src);
  const violations = findViolations(root, files, ALLOWED);

  if (violations.length > 0) {
    console.error("Single-redactor invariant violated (HLD §13.1).");
    console.error(
      "Only src/observability/redact.ts may define redaction patterns or use [REDACTED:*] placeholders.",
    );
    console.error("");
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  [${v.pattern}]`);
      console.error(`    ${v.text}`);
    }
    return 1;
  }

  console.log("single-redactor invariant OK");
  return 0;
}

// Only execute when run as a script, not when imported by tests.
if (import.meta.main) {
  process.exit(main());
}
