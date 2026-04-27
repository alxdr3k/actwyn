# Testing

> Status: thin current-state map · Owner: project lead ·
> Last updated: 2026-04-26
>
> Commands listed here are the ones present in `package.json` and
> `scripts/`. Do not invent commands; if you need a new one, add it
> to `package.json` first and update this file in the same PR.

## Toolchain

- **Runtime**: Bun (pinned in `.bun-version` and
  `config/runtime.json#required_bun_version`).
- **Type system**: TypeScript 5.6.3 (devDependency in
  `package.json`).
- **Test runner**: Bun's built-in `bun test`.
- **No separate ESLint / Prettier in P0** — formatting is
  hand-maintained, lint is the single-redactor invariant only.

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
```

This runs `scripts/check-single-redactor.ts`, which enforces the
HLD §13.1 single-redactor invariant: only
`src/observability/redact.ts` may define redaction patterns or emit
`[REDACTED:*]` placeholders.

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
- `test/db/invariants.test.ts` — cross-table invariants from
  HLD §5.2.
- `src/db/migrator.ts` — refuses missing prior versions at runtime,
  records applied versions in `settings`.

Judgment System proposal-surface tests (Phase 1A.2) live under:

- `test/judgment/validators.test.ts` — pure-TS validator behavior.
- `test/judgment/repository.test.ts` — `proposeJudgment` DB
  integration: insert, defaults, validation rejections, FTS trigger,
  transaction rollback.
- `test/judgment/tool.test.ts` — `executeJudgmentProposeTool`
  contract + static boundary assertions (no bun:* import in
  `src/judgment/*`; tool not imported by runtime modules).

When you add a migration:

1. Add `migrations/<NNN>_<slug>.sql` (versions contiguous from 001).
2. Update `expected_schema_version` in `src/main.ts` (currently
   4) so `/doctor` flags drift.
3. Update `docs/DATA_MODEL.md` and `docs/CODE_MAP.md`.
4. Re-run `bun run ci`.

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
bun run lint:redactor && bun run typecheck && bun test
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
