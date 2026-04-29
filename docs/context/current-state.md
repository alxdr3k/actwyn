# Current State

> Status: compressed current-state entrypoint · Owner: project lead ·
> Last updated: 2026-04-29
>
> First read for new AI/human sessions. Keep this short. The full
> roadmap/status ledger lives in `docs/04_IMPLEMENTATION_PLAN.md`.

## Product / project

actwyn is a single-user Telegram personal agent backed by a Bun +
TypeScript runtime, SQLite state, Claude CLI provider execution, and
Hetzner Object Storage for artifacts. The original P0 vertical is
implemented on `main`; P0 acceptance/staging rows remain not-run until
the acceptance plan is executed on a configured host.

## Current roadmap position

- Current milestone: `P0-M5` implementation landed; P0 Acceptance gate
  not run.
- Active tracks: `OPS` (acceptance/dogfood) and `JDG` (future Judgment
  convergence slices when explicitly authorized).
- Current ready OPS leaf: `OPS-1A.1` acceptance environment inventory.
- Current ready feature leaf: none. `JDG-1C.2c` landed DEC-041; known
  future feature leaves are inventoried but not ready.
- Latest docs slice: `DOC-1B.2` known future/deferred leaf inventory.
- Last local validation: `bun run ci` passed on 2026-04-29 for the
  `DOC-1B.2` known future/deferred leaf inventory update.
- Next gate: P0 acceptance/staging work.
- Canonical ledger: `docs/04_IMPLEMENTATION_PLAN.md`.

## Implemented

- P0 Telegram + Claude personal-agent runtime, queue, ledgers,
  outbound notifications, memory summaries, attachment capture/S3,
  commands, startup recovery, deploy docs.
- DB-native Judgment substrate through local schema/repository/tool
  contracts and Control Gate helpers.
- Runtime Judgment reachability through Control Gate telemetry,
  active/eligible judgment context injection, and Telegram Judgment
  read/write/retirement commands.
- ADR-0017 first convergence slice: summaries no longer auto-promote
  extracted items to active `memory_items`; memory persistence and
  Judgment proposal gates are split; active judgments outrank memory
  recall in context packing.
- `JDG-1C.2a`: structured `summary_generation` output now creates
  proposed Judgment rows only; it does not approve, link evidence,
  commit, activate, or register provider tools.
- `JDG-1C.2b`: summary completion notifications now include
  auto-proposed Judgment counts, short IDs, and review command hints.

## Planned / deferred

- P0 acceptance/staging execution and dogfood evidence collection.
- Freeform provider-output Judgment extraction is excluded for MVP by
  DEC-041. Optional analyzer leaves are `JDG-1C.2d` and `JDG-1C.2e`.
- Provider tool registration for Judgment tools, only after explicit
  authorization.
- `current_operating_view` and compiler input sourced from it.
- Goal / Value, WorkspaceTrace, Reflection/Tension control-plane, eval
  harness, procedure library, attention scoring, advanced lifecycle,
  and research-update automation leaves.
- Vector / graph derived projections.

## Explicit non-goals

- second-brain repo, Obsidian, or Markdown sidecars as canonical
  runtime memory.
- Provider-level Judgment tool registration without a scoped task.
- Tension, ReflectionTriageEvent, Critique Lens automation, and
  vector/graph projections in the current slice.

## Current risks / unknowns

- Acceptance files still use many `pending` statuses; read those as
  staging gate status, not implementation state.
- `memory_base_path` JSONL/MD sidecar policy remains open in Q-065.
- `src/context/builder.ts` deletion timing remains open in Q-066.
- Phase 0 design archive/move policy remains open under Q-063.

## Links

- Roadmap/status ledger: `docs/04_IMPLEMENTATION_PLAN.md`
- Architecture: `docs/ARCHITECTURE.md`
- Runtime: `docs/RUNTIME.md`
- Code map: `docs/CODE_MAP.md`
- Testing: `docs/TESTING.md`
- Acceptance: `docs/06_ACCEPTANCE_TESTS.md`
- Questions: `docs/07_QUESTIONS_REGISTER.md`
- Decisions: `docs/08_DECISION_REGISTER.md`
- Traceability: `docs/09_TRACEABILITY_MATRIX.md`
- Documentation policy: `docs/DOCUMENTATION.md`
