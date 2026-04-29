# Testing

> Status: thin current-state map · Owner: project lead ·
> Last updated: 2026-04-29
>
> This file is an index, not an implementation log. Replace
> current-state summaries; do not append phase history.
>
> This file lists verification commands (`test`, `typecheck`, `lint:redactor`,
> `lint:thin-docs`, `ci`). The `dev` script (`bun run dev`) is a local service runner, not a
> test command, and is not part of `bun run ci` — see `docs/OPERATIONS.md`
> for local dev setup.
>
> Do not invent commands; if you need a new one, add it to `package.json`
> first and update this file in the same PR.

## Toolchain

- **Runtime**: Bun (pinned in `.bun-version` and
  `config/runtime.json#required_bun_version`).
- **Type system**: TypeScript 5.6.3 (devDependency in
  `package.json`).
- **Test runner**: Bun's built-in `bun test`.
- **No separate ESLint / Prettier in P0** — formatting is
  hand-maintained. Linting is limited to the single-redactor
  invariant and the thin-docs guard.

Check the pinned Bun version:

```sh
cat .bun-version
```

## Install

```sh
bun install --frozen-lockfile
```

`bun install` (without the flag) also works in dev. CI must use
`--frozen-lockfile` so `bun.lock` drift is caught.

## Typecheck

```sh
bun run typecheck
```

(Runs `bunx --bun tsc --noEmit` per `package.json#scripts.typecheck`.)

## Lint

```sh
bun run lint:redactor
bun run lint:thin-docs
```

This runs:

- `scripts/check-single-redactor.ts`, which enforces the HLD §13.1
  single-redactor invariant: only `src/observability/redact.ts` may
  define redaction patterns or emit `[REDACTED:*]` placeholders.
- `scripts/check-thin-docs.ts`, which enforces thin current-state doc
  line budgets and role notes.

There is no general-purpose ESLint/Prettier step in P0. If you
introduce one, update this file.

## Unit tests

```sh
bun test
```

This runs the entire `test/` tree. Every file under `test/` is a
unit-or-integration test (see `docs/CODE_MAP.md` "Tests" section
for the test-to-feature map).

Run a subset:

```sh
bun test test/queue/
bun test test/notifications/state_machine.test.ts
```

## Integration tests

There is no separate integration-test runner in P0. Tests that
exercise multiple modules (e.g. `test/db/invariants.test.ts`,
`test/notifications/worker_wiring.test.ts`,
`test/startup/recovery.test.ts`) live alongside the unit tests and
run under the same `bun test` command.

Tests use a fresh in-memory or temp-file SQLite per case; they do
not require a running service, S3 endpoint, or Telegram credentials.

## DB / migration checks

There is no standalone migration-check command in `package.json`.
Migration shape is asserted by:

- `test/db/schema.test.ts` — schema-level shape and migration
  ordering.
- `test/db/judgment_schema.test.ts` — Judgment System schema
  CHECK / NOT NULL / JSON validity / FTS5 trigger coverage
  (Phase 1A.1).
- `test/db/control_gate_schema.test.ts` — `control_gate_events`
  schema CHECK / NOT NULL / JSON validity / append-only trigger
  coverage including INSERT OR REPLACE block (Phase 1A.8).
- `test/db/invariants.test.ts` — cross-table invariants from
  HLD §5.2.
- `src/db/migrator.ts` — refuses missing prior versions at runtime,
  records applied versions in `settings`.

Judgment System Phase 1A.2–1A.8 (proposal, review, source-recording,
evidence-linking, commit, query, explain, retirement lifecycle, Control
Gate) and Phase 1B.1–1B.5 (runtime telemetry, context injection,
Telegram read/write/retirement commands) tests live under:

- `test/judgment/validators.test.ts` — pure-TS judgment validator coverage.
- `test/judgment/repository.test.ts` — judgment repository lifecycle,
  transaction, query/explain, and retirement coverage.
- `test/judgment/control_gate.test.ts` — Control Gate decisions,
  fixture coverage, persistence, and import-boundary assertions.
- `test/judgment/tool.test.ts` — typed-tool contracts, executor
  outcomes, and runtime import-boundary assertions.
- `test/context/compiler.test.ts` — Stage 4 Context Compiler v0:
  replay/resume modes, judgment scope/time filters, summary-generation
  exclusion (skipJudgments), and PromptOverflowError propagation.
- `test/context/builder_judgments.test.ts` — judgment context slot
  rendering and priority behavior.
- `test/queue/control_gate_telemetry.test.ts` — worker telemetry writes
  and system-command exclusions.
- `test/queue/judgment_commands.test.ts` — Judgment read, write, and
  retirement Telegram command dispatch/output behavior.
- `test/queue/judgment_context_injection.test.ts` — worker-side
  active judgment query filters and packed-context injection (both
  replay_mode and resume_mode judgment refresh, issue #44).

When you add a migration:

1. Add `migrations/<NNN>_<slug>.sql` (versions contiguous from 001).
2. Update `expected_schema_version` in `src/main.ts` (currently
   6) so `/doctor` flags drift.
3. Update `docs/DATA_MODEL.md` and `docs/CODE_MAP.md`.
4. Regenerate the schema doc: `bun run docs:generate:schema` and commit
   `docs/generated/schema.md`.
5. Re-run `bun run ci`.

## Performance benchmark

```sh
bun run bench:context
bun run bench:context --iterations 200
bun run bench:context --json
```

Runs `scripts/bench-context-compiler.ts`. Seeds a deterministic temp SQLite DB
with 20 turns, 50 memory items, 1 summary, and 20 global judgments, then times
the DB-read and packing phases separately. Reports p50/p95/max and compares
against ADR-0014 P4 budgets:

| Phase     | p95 budget | hard cap |
| --------- | ---------- | -------- |
| db_read   | 50ms       | 150ms    |
| packing   | 50ms       | —        |

Exit code 0 = all budgets met, 1 = at least one exceeded. The benchmark is
**not** part of `bun run ci` — run it manually before Judgment System work or
when context latency regressions are suspected.

Benchmark tests live in `test/context/bench_context_compiler.test.ts` and run
under `bun test`.

## Eval fixtures

No eval-harness command currently defined. Stream-json parser
fixtures live alongside their tests
(`test/providers/parser.test.ts`).

## CI bundle

```sh
bun run ci
```

This is the all-in-one pre-PR check. It runs (per
`package.json#scripts.ci`):

```
bun run lint:redactor && bun run lint:thin-docs && bun run typecheck && bun test
```

## Before opening a PR

Recommended checklist:

- [ ] Run `bun run ci` locally and confirm it passes.
- [ ] If you changed migrations or schema, also confirm
      `expected_schema_version` in `src/main.ts` matches the new
      highest migration number, and `docs/DATA_MODEL.md` is updated.
- [ ] If you changed runtime behavior, update `docs/RUNTIME.md`.
- [ ] If you added or moved files, update `docs/CODE_MAP.md`.
- [ ] If you changed scripts in `package.json`, update this file.
- [ ] If you made an architecture-level decision, add or supersede
      an ADR.

If you cannot run `bun run ci` (no Bun on the machine, no network
for `bun install`, etc.), say so explicitly in the PR description
rather than claiming green.
