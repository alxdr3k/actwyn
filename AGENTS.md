# AGENTS.md

Guidance for AI coding agents working in this repo. Keep it short.

## Read order

For a normal implementation task, read in this order and stop as
soon as you have enough:

1. `docs/ARCHITECTURE.md` — what is implemented, what is planned.
2. `docs/CODE_MAP.md` — where the relevant module lives.
3. `docs/TESTING.md` — how to validate.
4. The task-relevant files in `src/` and `test/`.
5. The relevant ADR in `docs/adr/` **only if** the task changes
   architecture.

Do not read the long P0 design docs (`docs/PRD.md`, `docs/02_HLD.md`,
`docs/00_PROJECT_DELIVERY_PLAYBOOK.md`, `docs/03_RISK_SPIKES.md`,
`docs/04_IMPLEMENTATION_PLAN.md`, `docs/05_RUNBOOK.md`,
`docs/06_ACCEPTANCE_TESTS.md`) by default. Open them only when:

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
- Thin current-state docs (`docs/ARCHITECTURE.md`, `docs/CODE_MAP.md`,
  `docs/DATA_MODEL.md`, `docs/RUNTIME.md`, `docs/TESTING.md`,
  `docs/OPERATIONS.md`) explain the current shape but never override
  the code.
- ADRs explain why decisions were made; accepted ADRs are not edited
  to chase later changes.
- Long design docs are historical reasoning and an acceptance
  contract for the P0 vertical. They are not authority for current
  runtime behavior.
- The DB-native AI-first Judgment System direction is **committed
  and partially implemented** (Phase 1A). ADR-0009 … ADR-0013 and
  `docs/JUDGMENT_SYSTEM.md` are the architectural authority for *why*.
  Current state (per DEC-037):
  - **Phase 1A.1 (landed)**: `migrations/004_judgment_skeleton.sql`
    (5 tables + FTS5), `src/judgment/types.ts`,
    `src/judgment/validators.ts`.
  - **Phase 1A.2 (landed)**: `src/judgment/repository.ts`
    (proposal-only writer), `src/judgment/tool.ts` (unregistered
    `judgment.propose` typed-tool contract).
  - **Phase 1A.3 (landed)**: `src/judgment/repository.ts` now also
    exports `approveProposedJudgment` and `rejectProposedJudgment`
    (local unregistered approval/rejection review surface).
    `src/judgment/tool.ts` now also exports `JUDGMENT_APPROVE_TOOL` /
    `JUDGMENT_REJECT_TOOL` and `executeJudgmentApproveTool` /
    `executeJudgmentRejectTool`. These are **not runtime-wired**.
    Approval does **not** activate a judgment.
  - **Phase 1A.4 (landed)**: `src/judgment/repository.ts` now also
    exports `recordJudgmentSource` (writes `judgment_sources` +
    `judgment_events`) and `linkJudgmentEvidence` (writes
    `judgment_evidence_links`, updates denormalized arrays on
    `judgment_items`, appends `judgment.evidence.linked` event).
    `src/judgment/tool.ts` now also exports
    `JUDGMENT_RECORD_SOURCE_TOOL` / `JUDGMENT_LINK_EVIDENCE_TOOL` and
    `executeJudgmentRecordSourceTool` /
    `executeJudgmentLinkEvidenceTool`. These are **not runtime-wired**.
    Evidence linking does **not** activate, approve, or make a
    judgment context-visible.
  - **Phase 1A.5 (landed)**: `src/judgment/repository.ts` now also
    exports `commitApprovedJudgment`. Commit requires an approved,
    evidence-linked proposed judgment and sets
    `lifecycle_status=active` / `activation_state=eligible` /
    `authority_source=user_confirmed`. `src/judgment/tool.ts` now also
    exports `JUDGMENT_COMMIT_TOOL` / `executeJudgmentCommitTool`.
    These are **not runtime-wired**. Active/eligible judgment rows may
    now exist in the DB, but **runtime must not read them unless
    explicitly tasked** — no Context Compiler, no provider prompt
    integration, no Telegram command, and no memory-promotion path for
    judgments exists yet.
  - **Phase 1A.6 (landed)**: `src/judgment/repository.ts` now also
    exports `queryJudgments` and `explainJudgment`, and
    `src/judgment/tool.ts` now also exports `JUDGMENT_QUERY_TOOL` /
    `JUDGMENT_EXPLAIN_TOOL` and `executeJudgmentQueryTool` /
    `executeJudgmentExplainTool`. These are **local, unregistered,
    read-only** surfaces. They do **not** mutate judgment rows,
    append `judgment_events`, or make judgments context-visible.
  - **Phase 1A.7 (landed)**: `src/judgment/repository.ts` now also
    exports `supersedeJudgment`, `revokeJudgment`, and
    `expireJudgment`, and `src/judgment/tool.ts` now also exports
    `JUDGMENT_SUPERSEDE_TOOL` / `JUDGMENT_REVOKE_TOOL` /
    `JUDGMENT_EXPIRE_TOOL` and the corresponding `execute*` functions.
    These are **local, unregistered** write surfaces that retire
    `active/eligible` judgments. `supersedeJudgment` can write
    `judgment_edges`. None of these surfaces make judgments
    context-visible or register tools. They are **not runtime-wired**.
    Future agents must not implement context/compiler/provider
    integration unless explicitly tasked.
  - None of the judgment tools are **registered** anywhere in `src/`.
    They must not be imported from `src/main.ts`, `src/providers/*`,
    `src/context/*`, `src/queue/worker.ts`, `src/memory/*`,
    `src/telegram/*`, or `src/commands/*`.
  - Do **not** implement runtime-wired judgment integration, Control
    Gate, Tension, ReflectionTriageEvent, `current_operating_view`,
    Context Compiler, provider/context integration, vector / graph
    projections, Critique Lens, or any further runtime Judgment
    surface unless the task explicitly authorizes them.

## When changing code

- Update tests in the same change. Tests describe the contract;
  changing behavior without changing the test is a smell.
- If you change runtime behavior, update `docs/RUNTIME.md`.
- If you add, move, or rename modules, update `docs/CODE_MAP.md`.
- If you change schema, add a new migration file
  (`migrations/<NNN>_<slug>.sql`, contiguous from 001), bump
  `expected_schema_version` in `src/main.ts`, and update
  `docs/DATA_MODEL.md`.
- If you change validation commands or `package.json#scripts`,
  update `docs/TESTING.md`.
- If you change env vars, run paths, or operational steps, update
  `docs/OPERATIONS.md`.
- If you make an architecture-level decision, add a new ADR (or
  supersede an existing one) under `docs/adr/`.
- Do not rewrite long design docs to reflect implementation
  changes.

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

- Implementing Phase 1A Judgment System runtime surfaces beyond what
  is already landed (see "Source of truth" note above). That is a
  separate, larger track.
- Editing accepted ADRs to chase code changes — supersede instead.
- Rewriting long design docs to "match" implementation drift —
  patch the thin current-state docs.
- Adding redaction patterns outside `src/observability/redact.ts` —
  the lint will fail.
- Spawning Claude (or any provider) outside `src/providers/`.
