# Documentation Policy

> Status: living policy · Owner: project lead · Last updated: 2026-04-29
>
> Codified in **DEC-037** (Implementation Documentation Lifecycle
> Policy). This file is the operational shape of that policy and the
> docs-structure follow-up tracked by **Q-063**.

This file defines how docs in this repo relate to the code, who is
authoritative, and what to update when something changes.

## Source-of-truth hierarchy

1. Code, tests, migrations
2. Generated docs / schemas produced from those sources
   (`docs/generated/*`; see `docs/generated/README.md` for active generators)
3. Roadmap / status ledger (`docs/04_IMPLEMENTATION_PLAN.md`):
   milestone, track, phase, slice, gate, status, evidence, and next work
4. Compressed current state (`docs/context/current-state.md`) and thin
   current-state docs (`docs/ARCHITECTURE.md`, `docs/CODE_MAP.md`,
   `docs/DATA_MODEL.md`, `docs/RUNTIME.md`, `docs/TESTING.md`,
   `docs/OPERATIONS.md`)
5. ADRs in `docs/adr/`
6. Q / DEC registers and traceability matrix
   (`docs/07_QUESTIONS_REGISTER.md`, `docs/08_DECISION_REGISTER.md`,
   `docs/09_TRACEABILITY_MATRIX.md`)
7. Long design documents and archived design notes
   (`docs/PRD.md`, `docs/02_HLD.md`, `docs/00_PROJECT_DELIVERY_PLAYBOOK.md`,
   `docs/03_RISK_SPIKES.md`, `docs/05_RUNBOOK.md`, `docs/06_ACCEPTANCE_TESTS.md`,
   `docs/JUDGMENT_SYSTEM.md` (Phase 0 / 0.5 architectural design
   record, per DEC-037), future `docs/design/archive/*`)

Generated outputs sit in tier 2 (not tier 1) because they can lag
their source and become stale; the source code / migrations always
win. This matches `docs/generated/README.md`'s rule that a wrong
generated doc is fixed at the generator, not by hand-editing the
output.

## Rules

- Code, tests, and migrations are **authoritative** for implemented
  behavior. If a doc and the code disagree, the code wins.
- `docs/04_IMPLEMENTATION_PLAN.md` owns roadmap/status inventory:
  milestone, track, phase, slice, gate, implementation status, gate
  status, evidence, and next work.
- `docs/context/current-state.md` is the short first-read summary of
  the active position. Do not copy the full roadmap ledger into it.
- Thin current-state docs explain the current code shape but never
  override the code.
- Thin current-state docs do not own future roadmap inventory.
- ADRs explain **why** major decisions were made.
- Accepted ADRs are not edited to reflect later changes in
  implementation. If an architecture decision changes, create a new
  ADR that supersedes the old one.
- Long design docs (PRD, HLD, Phase 0 design records, Phase 1+ design
  records) capture intended direction and historical reasoning. They
  are not the source of truth for current runtime behavior.
- Do not rewrite long design docs on every implementation change.
  Prefer small, targeted patches in the thin current-state docs.
- Prefer generated docs for schema, API, and enum reference where
  generation is cheap.
- If a code change alters runtime behavior, schema, module layout,
  validation commands, or operational steps, update the matching
  thin current-state doc **in the same PR**.

## What to update when

| Change type                                  | Required doc action                                |
| -------------------------------------------- | -------------------------------------------------- |
| Roadmap taxonomy, slice status, gate status, evidence, or next work changes | update `docs/04_IMPLEMENTATION_PLAN.md` |
| Active milestone / track / phase / slice changes | update `docs/context/current-state.md` |
| Runtime behavior changes                     | update `docs/RUNTIME.md`                           |
| Module / file layout changes                 | update `docs/CODE_MAP.md`                          |
| DB / schema / migration changes              | update `docs/DATA_MODEL.md` + run `bun run docs:generate:schema` |
| Test / lint / typecheck command changes      | update `docs/TESTING.md`                           |
| Operational, env, or run-loop changes        | update `docs/OPERATIONS.md`                        |
| Major architecture decision                  | add a new ADR (or supersede an existing one)       |
| Tactical / policy decision                   | add an entry in `docs/08_DECISION_REGISTER.md`     |
| Open question that needs an answer           | add an entry in `docs/07_QUESTIONS_REGISTER.md`    |
| Historical design context only               | do not update current-state docs unless behavior changed |

## Roadmap / status migration

When adopting or updating the roadmap/status taxonomy, normalize scattered
roadmap language into `docs/04_IMPLEMENTATION_PLAN.md`:

1. Map product / user-facing gates to milestones.
2. Map technical streams to tracks.
3. Map ordered implementation stages inside each track to phases.
4. Map commit-sized implementation units to slices.
5. Map acceptance criteria, automated tests, staging checks, or manual
   verification to gates.
6. Split ambiguous `done` / `pending` states into implementation status
   (`planned`, `landed`, `accepted`, etc.) and gate status (`defined`,
   `not_run`, `passing`, etc.).
7. Move the canonical inventory into `04_IMPLEMENTATION_PLAN.md`, then trim
   duplicate status inventories from `docs/context/current-state.md`,
   thin current-state docs, runtime docs, architecture docs, and
   `AGENTS.md`.
8. Preserve source anchors when moving status: path, test, Q, DEC, ADR, AC,
   issue, or commit when known. If unknown, write `anchor missing` rather
   than inventing one.

## Enforcement mechanisms

These tools make the policy self-enforcing rather than honor-system only.

### Doc Freshness CI

`.github/workflows/doc-freshness.yml` fires on every PR and on every direct
push to `main`. If code in `src/` or `migrations/` changes without a
corresponding roadmap/status, acceptance gate, thin current-state doc,
generated doc, or ADR update, the workflow posts a warning listing the
missing items. The warning is non-blocking (does not prevent merge), but
should not be ignored.

Temporary: during the early-development period, direct `main` pushes are
permitted. The workflow covers this via a `push` trigger in addition to
`pull_request`. See `docs/policies/TEMP_MAIN_PUSH.md` for the graduation
checklist.

### SHA freshness headers

Thin docs that describe rapidly-evolving logic (LLM calls, judgment pipeline,
routing decisions) should carry a header on line 3–5:

```
> Last verified against code: <commit-SHA> (<YYYY-MM-DD>)
```

**Rule:** any commit that modifies code whose behaviour a SHA-headered doc
describes must also update that header. Stale headers are treated as a doc
gap, not a cosmetic issue.

No thin current-state behaviour docs currently carry SHA freshness headers.
`docs/generated/schema.md` is a generated exception: its `generated_at` /
SHA header is written automatically by `bun run docs:generate:schema` and
must not be edited by hand — only update it by re-running the generator.
Add SHA headers to thin docs only when a doc specifically tracks AI/LLM
call logic or judgment pipeline behaviour, not to every thin doc.

### Generated docs

`docs/generated/schema.md` is produced by `bun run docs:generate:schema` from
`migrations/*.sql`. Run the command and commit the output whenever a migration
is added or modified. Do not edit `docs/generated/*` by hand.

## Relationship to the existing P0 docs

The P0 deliverables in this repo (`docs/PRD.md`, `docs/02_HLD.md`,
`docs/00_PROJECT_DELIVERY_PLAYBOOK.md`, `docs/03_RISK_SPIKES.md`,
`docs/05_RUNBOOK.md`,
`docs/06_ACCEPTANCE_TESTS.md`) are the long-form design and acceptance
record for the Personal Agent P0 vertical. They remain valuable as
historical reasoning and acceptance-criteria references.

`docs/04_IMPLEMENTATION_PLAN.md` is the exception among the numbered
project docs: its top ledger is the canonical roadmap/status view,
while its older phase-by-phase build plan remains historical context.

For day-to-day implementation work, agents should prefer the thin
current-state docs and consult the long docs only when the question is
about *why* a P0 decision was made or what the original acceptance
contract requires.

If a long doc and the code diverge, fix the code first (or accept the
divergence and add an ADR/DEC entry); do not silently rewrite the
long doc to match.

## Phase 0 / 0.5 Judgment System direction

The DB-native, AI-first Judgment System architectural commitment has
landed on `main` (ADR-0009 … ADR-0013, `docs/JUDGMENT_SYSTEM.md`,
DEC-022 … DEC-036, Q-027 … Q-062). Per **DEC-037**, those documents
are **historical architectural records**: they explain *why* the
direction was chosen, but they are not the source of truth for
implemented runtime behavior and are not edited to chase
implementation drift.

The operative reference for "what is actually running" is the thin
current-state docs in this directory (`ARCHITECTURE.md`,
`CODE_MAP.md`, `DATA_MODEL.md`, `RUNTIME.md`, `TESTING.md`,
`OPERATIONS.md`) plus the code, tests, and migrations themselves.
Phase 1A.1–1A.8 are landed on `main`. Phase 0 / 0.5 design specs
are not rewritten; new ADRs supersede them where the architecture
changes.
