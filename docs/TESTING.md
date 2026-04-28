# Testing

> Status: thin current-state map · Owner: project lead ·
> Last updated: 2026-04-27
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
- `test/db/control_gate_schema.test.ts` — `control_gate_events`
  schema CHECK / NOT NULL / JSON validity / append-only trigger
  coverage including INSERT OR REPLACE block (Phase 1A.8).
- `test/db/invariants.test.ts` — cross-table invariants from
  HLD §5.2.
- `src/db/migrator.ts` — refuses missing prior versions at runtime,
  records applied versions in `settings`.

Judgment System proposal, review, source-recording, evidence-linking,
commit, query, explain, retirement lifecycle, and Control Gate surface
tests (Phase 1A.2–1A.8) live under:

- `test/judgment/validators.test.ts` — pure-TS validator behavior
  including `validateNonEmptyString` / `validatePlainJsonObject` /
  `validateTrustLevel` / `validateOptionalNonEmptyString`, plus
  query/explain helper validators for booleans, enum filters,
  pagination, ordering, and `scope_contains` (Phase 1A.3/1A.4/1A.6).
- `test/judgment/repository.test.ts` — `proposeJudgment` DB
  integration: insert, defaults, validation rejections, FTS trigger,
  transaction rollback; `approveProposedJudgment` /
  `rejectProposedJudgment` transitions, event payloads, state guards,
  rollback; `recordJudgmentSource` insert, defaults, trimming, event,
  rollback; `linkJudgmentEvidence` insert, state guards (including
  non-normal `retention_state` — archived/deleted target judgments
  fail with `JudgmentStateError` and no side effects), trimming,
  event, denormalized JSON array updates, rollback;
  `commitApprovedJudgment` success (state transition, event payload,
  evidence requirement, denormalized array sync), invalid state guards,
  malformed denormalized array element guards (invalid element types
  [123]/[null]/[{}]/[""] fail before update), validation rejections,
  transaction rollback; `queryJudgments` filters, FTS query,
  `scope_contains`, ordering, pagination, evidence metadata, and
  read-only behavior; `explainJudgment` evidence/source/event output,
  parsed JSON metadata, malformed persisted JSON handling, and
  no-mutation/no-event-append assertions; `supersedeJudgment` state
  transitions, `judgment_edges` insertion, `supersedes_json` /
  `superseded_by_json` JSON array updates, event payloads, invalid
  state guards (proposed/rejected/superseded/revoked/expired/archived),
  duplicate supersede guard, rollback on event/edge failure;
  `revokeJudgment` state transition, event payload, invalid state guards,
  rollback; `expireJudgment` state transition, `valid_until` logic,
  event payload, invalid state guards, rollback; and
  query/explain integration after retirement (superseded/revoked/expired
  rows hidden by default, visible with `include_history=true`, explain
  includes retirement events) (Phase 1A.3/1A.4/1A.5/1A.6/1A.7).
- `test/judgment/control_gate.test.ts` — `evaluateTurn` (L0/L1/L3),
  `evaluateCandidate` (L0/L1/L2/L3), 6 eval fixtures from
  `docs/JUDGMENT_SYSTEM.md §Eval fixtures`, `recordControlGateDecision`
  persistence round-trip, and static import boundary check (Phase 1A.8).
- `test/judgment/tool.test.ts` — `executeJudgmentProposeTool` /
  `executeJudgmentApproveTool` / `executeJudgmentRejectTool` /
  `executeJudgmentRecordSourceTool` /
  `executeJudgmentLinkEvidenceTool` / `executeJudgmentCommitTool` /
  `executeJudgmentQueryTool` / `executeJudgmentExplainTool` /
  `executeJudgmentSupersedeTool` / `executeJudgmentRevokeTool` /
  `executeJudgmentExpireTool`
  contracts + static boundary assertions (no bun:* import or `Bun`
  global use in `src/judgment/*`; all eleven tools not imported by
  runtime modules); `invalid_state` and `not_found` error paths for
  all lifecycle executors; no-mutation/no-event-append checks for
  failed supersede/revoke/expire calls; and `not_found` / `invalid_state`
  coverage for `executeJudgmentSupersedeTool` no-edge-insert check
  (Phase 1A.3/1A.4/1A.5/1A.6/1A.7).

When you add a migration:

1. Add `migrations/<NNN>_<slug>.sql` (versions contiguous from 001).
2. Update `expected_schema_version` in `src/main.ts` (currently
   5) so `/doctor` flags drift.
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
