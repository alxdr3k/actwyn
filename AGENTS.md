# AGENTS.md

Guidance for AI coding agents working in this repo. Keep it short.

## Read order

For a normal implementation task, read in this order and stop as
soon as you have enough:

1. `docs/context/current-state.md` — compressed current state.
2. `docs/04_IMPLEMENTATION_PLAN.md` — read the top
   "Current roadmap / status ledger" section for active milestone /
   track / phase / slice only.
3. `docs/ARCHITECTURE.md` — what is implemented, what is planned.
4. `docs/CODE_MAP.md` — where the relevant module lives.
5. `docs/TESTING.md` — how to validate.
6. The task-relevant files in `src/` and `test/`.
7. The relevant ADR in `docs/adr/` **only if** the task changes
   architecture.

Do not read the long P0 design docs (`docs/PRD.md`, `docs/02_HLD.md`,
`docs/00_PROJECT_DELIVERY_PLAYBOOK.md`, `docs/03_RISK_SPIKES.md`,
`docs/05_RUNBOOK.md`, `docs/06_ACCEPTANCE_TESTS.md`) by default.
For `docs/04_IMPLEMENTATION_PLAN.md`, read only the top current
ledger by default; open the historical phase plan below it only when:

- the task requires understanding *why* a P0 decision was made, or
- the task hits an acceptance criterion that is only described
  there.

Do not read `docs/JUDGMENT_SYSTEM.md` or `docs/adr/0009-…` …
`docs/adr/0013-…` by default. Those are the Phase 0 / 0.5
architectural design record for the DB-native AI-first Judgment
System (per DEC-037, a historical record). Open them only when:

- the task explicitly asks for Judgment System Phase 1A scoping
  or schema work, or
- you need to look up agreed terminology
  (`epistemic_origin` / `authority_source` / `lifecycle_status` /
  `activation_state` / `retention_state` / `current_operating_view`
  / `Tension` / `Control Gate`).

Do not read `docs/design/archive/` by default. Those are history.

## Source of truth

- Code, tests, and migrations are **authoritative** for implemented
  behavior.
- Generated docs / schemas (when generators land in
  `docs/generated/`) sit just below them — derived, not authority.
  If a generated doc looks wrong, fix the generator or the source,
  never the generated output by hand.
- `docs/04_IMPLEMENTATION_PLAN.md` owns roadmap/status inventory:
  milestone, track, phase, slice, gate, implementation status, gate
  status, evidence, and next work.
- `docs/context/current-state.md` is the compressed first-read state
  and active roadmap position. Keep it short; do not copy the full
  ledger into it.
- Thin current-state docs (`docs/ARCHITECTURE.md`, `docs/CODE_MAP.md`,
  `docs/DATA_MODEL.md`, `docs/RUNTIME.md`, `docs/TESTING.md`,
  `docs/OPERATIONS.md`) explain the current shape but never override
  the code. They do not own future roadmap inventory.
- ADRs explain why decisions were made; accepted ADRs are not edited
  to chase later changes.
- Long design docs are historical reasoning and an acceptance
  contract for the P0 vertical. They are not authority for current
  runtime behavior.
- The DB-native AI-first Judgment System direction is **committed
  and partially implemented** (Phase 1A+). ADR-0009 … ADR-0013,
  ADR-0015, ADR-0017, and `docs/JUDGMENT_SYSTEM.md` are the
  architectural authority for *why*.
- Current Judgment status lives in `docs/04_IMPLEMENTATION_PLAN.md`
  track `JDG`, `docs/ARCHITECTURE.md`, and `docs/RUNTIME.md`.
  Summary:
  - Phase 1A.1–1A.8 local substrate is landed under `src/judgment/*`
    plus migrations 004–006.
  - Phase 1B.1–1B.5 runtime wiring is landed through
    `src/queue/worker.ts`: Control Gate telemetry, active/eligible
    judgment context injection, Telegram read/write commands, and
    retirement commands.
  - ADR-0017 / DEC-039 first runtime slice is landed: memory
    provenance gates are split, summary extraction no longer writes
    active `memory_items`, and active judgments outrank memory recall
    in context packing.
  - The `judgment_items` context slot priority is 790.
  - Remaining Phase 1A constraints still apply to all modules except
    `src/queue/worker.ts`:
    - `src/main.ts`, `src/providers/*`, `src/memory/*`,
      `src/telegram/*`, and `src/commands/*` must NOT import from
      `src/judgment/*`.
    - `src/context/*` may contain the existing Judgment context slot /
      compiler input types, but do not add new Judgment runtime paths
      there unless explicitly tasked.
  - Do **not** implement Tension, ReflectionTriageEvent,
    `current_operating_view`, provider/context integration beyond the
    existing compiler/context-injection path, vector / graph projections,
    Critique Lens, Claude tool registration for judgment tools, or
    additional Judgment runtime paths unless the task explicitly
    authorizes them.

## When changing code

- Update tests in the same change. Tests describe the contract;
  changing behavior without changing the test is a smell.
- If roadmap position, slice status, gate status, evidence, or next
  work changes, update `docs/04_IMPLEMENTATION_PLAN.md`.
- If the active milestone / track / phase / slice changes, update
  `docs/context/current-state.md`.
- If you change runtime behavior, update `docs/RUNTIME.md`.
- If you add, move, or rename modules, update `docs/CODE_MAP.md`.
- If you change schema, add a new migration file
  (`migrations/<NNN>_<slug>.sql`, contiguous from 001), bump
  `expected_schema_version` in `src/main.ts`, update
  `docs/DATA_MODEL.md`, and run `bun run docs:generate:schema` then
  commit `docs/generated/schema.md`.
- If you change validation commands or `package.json#scripts`,
  update `docs/TESTING.md`.
- If you change env vars, run paths, or operational steps, update
  `docs/OPERATIONS.md`.
- If you make an architecture-level decision, add a new ADR (or
  supersede an existing one) under `docs/adr/`.
- Do not rewrite long design docs to reflect implementation
  changes.
- If the thin doc you are editing carries a `Last verified against
  code: <SHA> (<date>)` header, update the SHA and date to the
  current commit before pushing.

## Validation

Use the commands in `docs/TESTING.md`. The pre-PR bundle is:

```sh
bun run ci
```

Do not invent validation commands. If you cannot run the validation
(no Bun, no network, isolated environment), say so explicitly in
the PR description rather than claiming green.

## Conventions

- Path alias: `~/*` resolves to `src/*` (see `tsconfig.json`).
- Single-redactor invariant: only `src/observability/redact.ts`
  may define redaction patterns or emit `[REDACTED:*]` placeholders.
  Lint is `bun run lint:redactor`.
- Each table has a single-writer module. The thin operative table
  is in `docs/DATA_MODEL.md` §Single-writer map; the full reasoning
  is in `docs/02_HLD.md` §5.1 (only open the HLD if you need the
  reasoning, not the lookup). If you need to mutate a table from a
  new module, route through the existing owner instead.
- New env vars must appear in `.env.example` and `src/config.ts`
  validation.
- Avoid editing `bun.lock` by hand; let `bun install` regenerate it.

## What to avoid

- Implementing additional Judgment runtime surfaces beyond what is
  already landed (see the `JDG` track in
  `docs/04_IMPLEMENTATION_PLAN.md`). That is a separate, larger track.
- Editing accepted ADRs to chase code changes — supersede instead.
- Rewriting long design docs to "match" implementation drift —
  patch the thin current-state docs.
- Adding redaction patterns outside `src/observability/redact.ts` —
  the lint will fail.
- Spawning Claude (or any provider) outside `src/providers/`.
