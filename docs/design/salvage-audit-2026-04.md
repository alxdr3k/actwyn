# Implementation Salvage Audit — 2026-04

> Status: design exploration record (one-shot audit) · Owner: project lead ·
> Created: 2026-04-27
>
> This is a **design note**, not an ADR and not a current-state doc.
> Per `docs/design/README.md` it is exploration / reasoning material:
> the audit's classifications inform follow-up PRs, but the
> authoritative current shape lives in `docs/CODE_MAP.md`,
> `docs/ARCHITECTURE.md`, and the relevant ADRs.
>
> This audit performs **no code changes**. It only classifies the
> existing implementation against the planned DB-native AI-first
> Judgment System direction (ADR-0009 … ADR-0013,
> `docs/JUDGMENT_SYSTEM.md`) so subsequent PRs have an explicit
> decision baseline.

## 1. Why this audit exists

The Phase 0 / 0.5 architectural design for the Judgment System
landed on `main` via PR #10 as ADR-0009 … ADR-0013 plus
`docs/JUDGMENT_SYSTEM.md`. Per **DEC-037** the design is
architectural authority for *why*, but **not** authority for
runtime behavior — none of the planned schemas, typed tools,
Control Gate evaluators, or projections are implemented in
`src/` or `migrations/` yet.

The pre-existing P0 implementation (memory summaries,
`memory_items` provenance, attachment promotion, slot-based
context packing) was built under the PRD / HLD contract and was
flagged `needs audit` in `docs/CODE_MAP.md`. This document
performs that audit.

The audit answers, per module: **KEEP / ADAPT / REPLACE / DELETE**
under the new direction, with a recommended next PR.

## 2. Scope and method

Inspected:

- `src/commands/`, `src/context/`, `src/db/`, `src/memory/`,
  `src/observability/`, `src/providers/`, `src/queue/`,
  `src/startup/`, `src/storage/`, `src/telegram/`,
  `src/config.ts`, `src/db.ts`, `src/main.ts`, `migrations/`,
  `test/`.
- Authoritative documents for the new direction:
  `docs/JUDGMENT_SYSTEM.md`, ADR-0006, ADR-0009, ADR-0010,
  ADR-0011, ADR-0012, ADR-0013, plus the thin current-state docs
  for the implemented vertical.

Special-focus checks (per the audit brief):

1. Does any code assume Obsidian / GitHub second-brain repo as
   active runtime memory?
2. Does any code conflate memory and judgment?
3. Does context packing depend on stale memory semantics?
4. Does memory promotion allow `assistant_generated` /
   `inferred` durable memory?
5. Does any code need to become control-plane telemetry rather
   than judgment-plane state?
6. Are tests reusable as behavior fixtures even if implementation
   changes?

## 3. Headline conclusions

| Question | Finding |
|----------|---------|
| Obsidian / GitHub second-brain runtime assumptions in code | **None.** No source file references obsidian / markdown-vault / second-brain / GitHub repo runtime. Position matches ADR-0009 §2 ("not canonical, seed corpus / export / archive only"). |
| memory ↔ judgment conflation in code | **None.** No `judgment_*` table, typed tool, `current_operating_view`, `epistemic_origin`, `authority_source`, `Tension`, `Control Gate`, or `Critique Lens` identifier exists in `src/` or `migrations/`. AGENTS.md "Phase 1A out of scope" is honored. |
| Context packing depends on stale memory semantics | **Partial.** `src/context/builder.ts` accepts `MemoryItemSlot.provenance` / `.status` directly, and `src/queue/worker.ts#buildContextForRun` reads `memory_items WHERE status='active'` + `memory_summaries (latest)` to drive the slot taxonomy. Stage 4 Context Compiler will source from `current_operating_view` (lifecycle_status / activation_state / authority priority) instead. |
| Memory promotion allows `assistant_generated` / `inferred` durable memory | **Partially yes — under a careful reading.** `src/memory/provenance.ts#mayPromoteToLongTerm` only gates `preference` to `user_stated` / `user_confirmed`. `src/memory/summary.ts#writeSummary` then promotes `facts` / `decisions` / `open_tasks` / `cautions` from any provenance to `memory_items` with `status='active'`. `src/queue/worker.ts#buildContextForRun` injects those rows into the next provider run. `docs/JUDGMENT_SYSTEM.md` §Relationship to memory layer (ADR-0006) and §Authority Source (ADR-0012) > Procedure/policy 권위 결정 패턴 require `assistant_generated` / `inferred` items to remain proposal-only — that gate must be added in the judgment layer, AND the memory→context injection path must be re-evaluated under Q-027 before the gate is meaningful. |
| Code that must *become* control-plane telemetry | **None forced.** ADR-0012 §6 commits to control-plane / judgment-plane separation as **additive**. `observability/events`, `queue/worker`, `startup/recovery`, `telegram/inbound` all stay as observability / runtime; new control-plane tables (`tensions`, `reflection_triage_events`, etc.) are introduced in their own writers. |
| Tests reusable as behavior fixtures | **Yes.** No ADR or design doc requires retiring P0 acceptance tests. They are retained as regression fixtures; some `test/context/*` and `test/memory/summary.test.ts` expectations will need adjustment after Compiler / Q-027 land. |

**Bottom line:** Most of the P0 runtime survives. The only
REPLACE candidate is `src/context/builder.ts`. Four modules
(`src/queue/worker.ts`, `src/memory/summary.ts`,
`src/memory/provenance.ts`, `src/memory/items.ts`) are ADAPT
because the **automatic memory → active memory_items → worker
context injection** path needs to be reshaped before judgment
proposals become meaningful. **No DELETE candidates.**

## 4. Module classification

Each row uses the deliverable spec format:
**path · current role · classification · reason · recommended next PR**.

Classification legend: KEEP · ADAPT · ADAPT-light · REPLACE · DELETE.
"Recommended next PR" references step numbers in §6 (or `n/a` when
the module is fully covered by PR 1, this docs-only PR).

### 4.1 Composition root, config, DB layer

| path | current role | classification | reason | recommended next PR |
|------|--------------|----------------|--------|---------------------|
| `src/main.ts` | systemd entrypoint and composition root; wires real Telegram / Claude / S3 transports, runs boot doctor + startup recovery, launches poller + worker loops. | **ADAPT** | P0 invariant intact. `summaryAdapter` (advisory profile) wiring already isolates a non-default Claude profile — Critique Lens (ADR-0013) reuses the same pattern. `ACTWYN_MEMORY_PATH` → `memory_base_path` wiring depends on the JSONL / MD sidecar policy decision (§5.3). | §6 step 4 / 5 (compiler wiring); §6 step 10 (sidecar) |
| `src/config.ts` | Typed env + `config/runtime.json` loader; fail-fast validation; frozen view exposed to runtime. | KEEP | Phase 1A judgment env vars (critique model, vector backend) extend by appending — existing fields unchanged. | n/a (extended on demand by future PRs) |
| `src/db.ts` | bun:sqlite handle factory with WAL / busy_timeout / FK / `BEGIN IMMEDIATE` writer txn. | KEEP | ADR-0003 (SQLite canonical) preserved without supersession; `docs/JUDGMENT_SYSTEM.md` §Refs cross-references it as a still-valid foundation. | n/a |
| `src/db/migrator.ts` | Forward-only migration runner; records applied versions in `settings`; refuses gaps. | KEEP | Phase 1A `judgment_*` tables land as `migrations/004_*.sql` via the same runner. | n/a (consumed by §6 step 2) |
| `migrations/001_init.sql` | Base tables (allowed_users / settings / telegram_updates / sessions / jobs / provider_runs / provider_raw_events / turns / outbound_notifications / outbound_notification_chunks / memory_summaries / memory_items). | KEEP | All P0 implemented schema. Judgment schema is layered above per ADR-0009 분리. | n/a |
| `migrations/002_artifacts.sql` | `storage_objects`, `memory_artifact_links`. | KEEP | Reused by judgment evidence links unchanged. | n/a |
| `migrations/003_notification_payload_text.sql` | Adds `payload_text` to `outbound_notifications`. | KEEP | Notification path is judgment-orthogonal. | n/a |

### 4.2 Telegram / providers / storage (P0 transports)

| path | current role | classification | reason | recommended next PR |
|------|--------------|----------------|--------|---------------------|
| `src/telegram/poller.ts` | Long-poll loop; advances `settings['telegram.next_offset']`. | KEEP | ADR-0002 preserved. | n/a |
| `src/telegram/inbound.ts` | Classifies updates (text / command / attachment / unauthorized) and enqueues. | KEEP | Tension / triage / interaction-signal hooks are additive (separate emitter); classifier itself stays. | §6 step 8 (additive control-plane hook only) |
| `src/telegram/outbound.ts` | `sendMessage` executor; drives `outbound_notifications` + chunk states. | KEEP | Judgment-orthogonal. | n/a |
| `src/telegram/bot_api.ts` | Telegram Bot API HTTP transport (no framework dependency). | KEEP | Judgment-orthogonal. | n/a |
| `src/telegram/attachment_capture.ts` | Phase-2 attachment download + MIME probe. | KEEP | Two-phase capture is preserved. | n/a |
| `src/telegram/attachment_metadata.ts` | Phase-1 attachment metadata persistence. | KEEP | Judgment-orthogonal. | n/a |
| `src/telegram/types.ts` | Shared Telegram update type aliases. | KEEP | Pure types. | n/a |
| `src/providers/claude.ts` | Claude Code CLI adapter; spawns subprocess, parses stream-json, manages resume / replay. | KEEP | ADR-0005 preserved. Critique Lens (ADR-0013) reuses the `summaryAdapter` advisory-profile pattern as a third profile rather than refactoring the adapter. | n/a |
| `src/providers/fake.ts` | Deterministic fake provider used by tests. | KEEP | Test fixture surface. | n/a |
| `src/providers/stream_json.ts` | stream-json line parser + final-text normalisation. | KEEP | Judgment-orthogonal. | n/a |
| `src/providers/subprocess.ts` | Subprocess spawn / lifetime helpers (process group, abort). | KEEP | Judgment-orthogonal. | n/a |
| `src/providers/types.ts` | Provider-facing request / response / event types. | KEEP | Pure types. | n/a |
| `src/storage/local.ts` | Local FS reads / writes for objects and transcripts. | KEEP | ADR-0004 preserved. | n/a |
| `src/storage/s3.ts` | Hetzner Object Storage transport (`Bun.S3Client` based). | KEEP | ADR-0004 preserved. | n/a |
| `src/storage/sync.ts` | `storage_sync` worker; advances `storage_objects.status`. | KEEP | Judgment-orthogonal. Judgment evidence links reference rows here, not mutate them. | n/a |
| `src/storage/objects.ts` | DB-row builders / readers for `storage_objects`. | KEEP | Judgment-orthogonal. | n/a |
| `src/storage/mime.ts` | Magic-bytes MIME probe used during attachment capture. | KEEP | Judgment-orthogonal. | n/a |

### 4.3 Queue / startup

| path | current role | classification | reason | recommended next PR |
|------|--------------|----------------|--------|---------------------|
| `src/queue/worker.ts` | Single job claim + dispatch loop; one `provider_run` at a time; in-process attachment capture pre-step; dispatches `provider_run` / `summary_generation` / `storage_sync` / `notification_retry`. Hosts `buildContextForRun` and the JSONL / MD memory sidecar writer. | **ADAPT** | `buildContextForRun` (worker.ts L932-L1005) reads `memory_items WHERE status='active'`, `memory_summaries` (latest), `turns LIMIT 20`, and calls `buildContext` / `pack` / `renderAsMessage` / `serializeForProviderRun` directly. The Stage 4 Context Compiler must own retrieval and packing. JSONL / MD sidecar (worker.ts L1269-L1282; AC-MEM-001) is policy-pending — see §5.3. After extraction, the worker keeps queue claim / dispatch / state-machine / terminal commit only. | §6 step 5 (worker uses compiler — primary); §6 step 10 (sidecar policy applied) |
| `src/queue/notification_retry.ts` | Per-chunk re-send handlers for the `notification_retry` job_type. | KEEP | Judgment-orthogonal. | n/a |
| `src/startup/recovery.ts` | Boot-time reconciliation of stale `running` jobs (force `interrupted`, requeue if `safe_retry`, kill orphan PIDs); offset fast-forward; one-shot `storage_sync` enqueue for `failed` / `delete_failed` rows. | KEEP | AC-JOB-002 preserved. Recovery for new control-plane tables is additive (§6 step 8). | n/a (additive only via §6 step 8) |

### 4.4 Observability / commands

| path | current role | classification | reason | recommended next PR |
|------|--------------|----------------|--------|---------------------|
| `src/observability/events.ts` | Structured event emitter (level + name + JSON to stderr). | KEEP | Control-plane events persist to *new* tables via separate writers (ADR-0012 §6); this emitter is observability only. | n/a |
| `src/observability/redact.ts` | The single redactor; only module allowed to define redaction patterns or emit `[REDACTED:*]` placeholders (HLD §13.1). | KEEP | Single-redactor lint stays under judgment direction. | n/a |
| `src/commands/whoami.ts` | `/whoami` and `BOOTSTRAP_WHOAMI` flow (DEC-009). | KEEP | Operational; judgment-orthogonal. | n/a |
| `src/commands/provider.ts` | `/provider` switch (P0: only `claude`). | KEEP | Operational; judgment-orthogonal. | n/a |
| `src/commands/doctor.ts` | `/doctor` typed system smoke-test output. | KEEP | Operational; judgment-orthogonal. | n/a |
| `src/commands/status.ts` | `/status` typed queue / job status output (DEC-015). | KEEP | Operational; judgment-orthogonal. | n/a |
| `src/commands/cancel.ts` | `/cancel` to stop running or queued job. | KEEP | Operational; judgment-orthogonal. | n/a |
| `src/commands/correct.ts` | `/correct <id>` and natural-language `정정:` corrections; calls `supersedeMemoryItem`. | KEEP | DEC-007 supersede semantics retained for memory rows. Judgment row corrections are a separate `judgment.supersede` typed tool (added in §6 step 3). | n/a |
| `src/commands/forget.ts` | `/forget_last`, `/forget_session`, `/forget_artifact`, `/forget_memory`. | KEEP | DEC-006 tombstone semantics retained. ADR-0013 `lifecycle_status=revoked` mirrors the existing memory `revoked` state — no migration of existing rows needed. | n/a |
| `src/commands/save.ts` | `/save_last_attachment` and natural-language `저장해줘` promotion; writes `memory_artifact_links` with `provenance='user_stated'`. | KEEP | ADR-0006 explicit-save-first; already aligned with the judgment direction. Judgment evidence links can be *added* without changing this path. | n/a |
| `src/commands/summary.ts` | `/summary` and `/end` triggers; enqueue `summary_generation` job. | KEEP | DEC-019 trigger preserved. Summary stays memory-plane; judgment is a separate job_type if and when added. | n/a |

### 4.5 Memory layer (Q-027 — separation committed)

| path | current role | classification | reason | recommended next PR |
|------|--------------|----------------|--------|---------------------|
| `src/memory/items.ts` | `memory_items` writer with insert / supersede / revoke; enforces HLD §6.5 single-txn invariants. | **ADAPT-light** | Writer invariants are preserved. The insert path only blocks non-`user_stated` / non-`user_confirmed` when `item_type='preference'`; for `fact` / `decision` / `open_task` / `caution` it accepts any provenance into `status='active'`. Once Q-027 lands, the eligibility-for-behavior-baseline check moves to the judgment layer and this writer can stay as the literal `memory_items` writer. | §6 step 6 (Q-027 summary promotion policy) |
| `src/memory/provenance.ts` | 6-enum `Provenance` vocabulary + `mayPromoteToLongTerm(p, item_type)` gate (PRD §12.2). | **ADAPT** | The `Provenance` enum stays — it lines up cleanly with the planned `epistemic_origin` 6-enum on judgment rows (ADR-0012). `mayPromoteToLongTerm` conflates two questions: "may this row land in `memory_items`?" and "may this row become a behavior baseline / durable judgment?" Once judgment is introduced, the gate must split — for example `mayPersistAsMemoryItem`, `mayBecomeBehaviorBaseline`, `mayProposeJudgment` — so the names carry their own semantics. | §6 step 7 (split provenance gate semantics) |
| `src/memory/summary.ts` | `SUMMARY_SYSTEM_IDENTITY` advisory-profile prompt; `shouldAutoTriggerSummary` throttle decision; `writeSummary` persists `memory_summaries` row + promotes facts / preferences / open_tasks / decisions / cautions to `memory_items`. | **ADAPT** | The system prompt allows `inferred` / `assistant_generated` / `tool_output` provenance on every item type. `writeSummary` preference-gates only preferences and promotes the rest to `memory_items` with `status='active'` so the context packer / worker can inject them — exactly the property called out in `docs/JUDGMENT_SYSTEM.md` §Relationship to memory layer (ADR-0006) and §Authority Source (ADR-0012) > Procedure/policy 권위 결정 패턴 as forbidden once judgment lands. The writer itself can stay; the *automatic* promotion of fact / decision / open_task / caution must be re-routed (judgment proposal, evidence candidate, or control-plane trace) per Q-027. | §6 step 6 (Q-027 summary promotion policy) |

### 4.6 Context layer

| path | current role | classification | reason | recommended next PR |
|------|--------------|----------------|--------|---------------------|
| `src/context/builder.ts` | Pure builder; assembles 9 priority-ordered slots (`user_message`, `system_identity`, `active_project_context`, `current_session_summary`, `memory_user_stated`, `recent_turns`, `memory_other`, `inactive_project_context`, `verbose_transcript`) from caller-supplied inputs. | **REPLACE** | Slot taxonomy is bound to the PRD §12.4-12.5 single-`provenance` / `status='active'` model. The Stage 4 Context Compiler (JUDGMENT_SYSTEM.md §6-stage pipeline; ADR-0013 §4 `current_operating_view`) selects via `lifecycle_status` / `activation_state` hard filter + `authority_source` priority. The builder is the **only** module whose input contract itself is incompatible with the new model. | §6 step 4 (compiler added; builder kept in tree); §6 step 9 (builder removed) |
| `src/context/packer.ts` | Token-budget pruning by ascending slot priority; emits `PromptOverflowError`; serialises retained slots into `injected_snapshot_json`. | ADAPT | Drop-by-priority + token-budget pruner is reusable. Only the input type changes from `ContextSnapshot` to a new `CompilerOutput` / `ContextPacket`. `serializeForProviderRun` and the `injected_snapshot_json` shape stay so observability rows don't break. | §6 step 4 / 5 (input type rebound to compiler output) |
| `src/context/token_estimator.ts` | DEC-021 CJK-aware char-based pessimistic token estimator. | KEEP | Judgment-orthogonal; reused verbatim by the Compiler. | n/a |

### 4.7 Tests — KEEP, with selective expectation updates

All `test/` files stay as regression / behavior fixtures. No
fixture is retired in this audit.

| path | current role | classification | reason | recommended next PR |
|------|--------------|----------------|--------|---------------------|
| `test/config.test.ts` | Config loader — required env, runtime.json validation. | KEEP | Judgment-orthogonal. | n/a |
| `test/events.test.ts` | Event emitter contract. | KEEP | Judgment-orthogonal. | n/a |
| `test/redaction.test.ts`, `test/single-redactor.test.ts` | Redaction pattern coverage (DEC-010, AC-SEC-001) + single-redactor lint enforcement. | KEEP | HLD §13.1 invariant preserved. | n/a |
| `test/db/{invariants,schema}.test.ts` | Cross-table invariants (HLD §5.2) + schema / migration shape assertions. | KEEP | Judgment migrations land as new fixtures alongside (additive). | n/a (extended by §6 step 2) |
| `test/storage/{roundtrip,state_machine}.test.ts` | Local + S3 roundtrip; `storage_objects.status` transitions. | KEEP | ADR-0004 invariant. | n/a |
| `test/queue/*.test.ts` | Job claim atomicity; attachment capture; queue state machine. | KEEP | AC-JOB-* invariants. | n/a (worker refactor in §6 step 5 keeps these green) |
| `test/notifications/*.test.ts` | Notification chunking, ledger, retry state machine, worker wiring. | KEEP | AC-NOTIF-* invariants. | n/a |
| `test/providers/*.test.ts` | Claude adapter, fake provider, stream-json parser, subprocess lifecycle. | KEEP | AC-PROV-* invariants. | n/a |
| `test/telegram/*.test.ts` | Inbound classifier, poller offset durability, attachment metadata. | KEEP | AC-TG-* invariants. | n/a |
| `test/startup/recovery.test.ts` | Boot-time reconciliation behavior (AC-JOB-002). | KEEP | Judgment-orthogonal. | n/a |
| `test/memory/correction.test.ts` | Memory correction supersede semantics (AC-MEM-004). | KEEP | DEC-007 invariant preserved. | n/a |
| `test/commands/*.test.ts` | Per-command happy / error path coverage. | KEEP | Command surfaces unchanged in this audit. | n/a |
| `test/context/token_estimator.test.ts` | CJK-safer token estimator behaviour (DEC-021). | KEEP | Judgment-orthogonal; reused by Compiler. | n/a |
| `test/context/packer.test.ts` | Packer drop-order + token budget. | KEEP, expectation ADAPT | Drop algorithm survives, but input type changes from `ContextSnapshot` to Compiler output — the existing assertions stay as the regression fixture for the algorithm; new Compiler-shaped fixtures are added alongside. | §6 step 4 / 5 (rebind input type; add Compiler-shaped cases) |
| `test/memory/summary.test.ts` | Summary generation + provenance (AC-MEM-002). | KEEP, expectation ADAPT | Once Q-027 settles whether `fact` / `decision` / `open_task` / `caution` continue landing in `memory_items` automatically, the auto-promotion side-effect assertions are updated. The writer / throttle assertions stay. | §6 step 6 (Q-027 summary promotion policy) |

### 4.8 DELETE candidates

None. No obsolete, superseded, or unused module identified in
the inspected scope. If a future PR renders a module obsolete it
should be marked `possibly stale` in `docs/CODE_MAP.md` first
and removed in a follow-up PR (per the existing
`docs/CODE_MAP.md` §Stale / superseded policy).

## 5. Cross-cutting findings

### 5.1 Risk path: automatic promotion → worker context injection

```
user turn
    │
    ▼
summary_generation job (advisory profile)
    │ writeSummary()
    ▼
memory_summaries  (preference: user_stated/user_confirmed gate)
    │ promoteItems()  facts / decisions / open_tasks / cautions
    ▼
memory_items  (status='active', any provenance allowed)
    │ worker.buildContextForRun()
    │   SELECT * FROM memory_items WHERE status='active'
    ▼
buildContext → pack → renderAsMessage
    │
    ▼
provider_runs  (Claude's next turn input)
```

Within the P0 PRD / HLD contract this path is intentional —
preferences are the only durable identity claim, and the rest
are best-effort working memory. After judgment lands, `inferred`
/ `assistant_generated` items must not silently become behavior
baseline. The fix is **not** to delete the path but to:

1. Decide Q-027 (memory_items vs judgment_items relationship).
2. Route `fact` / `decision` / `open_task` / `caution` summary
   items to a judgment proposal queue (or evidence-candidate
   table) rather than directly to `memory_items.status='active'`.
3. Have the Compiler source from `current_operating_view`
   (lifecycle + activation + authority) instead of the raw
   `memory_items WHERE status='active'` query.

### 5.2 Worker-owned retrieval responsibilities (extraction targets)

| Responsibility | Current location | Target |
|----------------|-----------------|--------|
| recent turns (LIMIT 20) | `worker.ts buildContextForRun` (turns SELECT) | Stage 4 Compiler |
| memory_items (status='active') | same | Compiler (`current_operating_view` filter) |
| memory_summaries (latest) | same | Compiler |
| `buildContext` / `pack` / `renderAsMessage` / `serializeForProviderRun` | same | Compiler output + adapted packer |

The worker's queue claim, dispatch, state-machine transitions,
and terminal commit stay in place. `buildContextForRun` is a
single function — Compiler extraction is one call-site swap.

### 5.3 JSONL / MD filesystem sidecar — not Obsidian, but needs a policy

`src/queue/worker.ts` writes, on each `summary_generation`
terminal commit:

- `${memory_base_path}/sessions/<session_id>.jsonl` — append-only
  per session.
- `${memory_base_path}/personal/YYYY-MM-DD.md` — rolled-up daily
  marker line.

This is **not** an Obsidian / GitHub-repo runtime dependency.
It is a local human-readable export covered by AC-MEM-001. Under
the DB-native judgment direction the sidecar's role must be
explicitly classified:

- **Archive / debug telemetry only** (parallel to the S3 archive)
  — the truth lives in `memory_summaries` + `storage_objects`.
- **Behavior baseline contributor** — discouraged by the
  judgment direction; would re-create the auto-promotion risk.
- **Removed** — requires a PRD §12 / AC-MEM-001 amendment ADR.

This audit flags the sidecar as **policy-pending**; no code
change is recommended until the policy ADR lands. See §6 step
10.

### 5.4 Single-writer / single-redactor / P0 invariants

All preserved verbatim. No module in `src/` violates HLD §5.1
writer ownership or HLD §13.1 single-redactor. Phase 1A judgment
writers land as new modules with their own writer ownership
rows in the §5.1 map.

## 6. Recommended PR sequence

Suggested order of follow-up PRs. Each PR is small and the
ordering avoids cliff-edge migrations.

| # | PR title | Scope |
|---|----------|-------|
| 1 | `docs: salvage audit (this PR)` | Save this document under `docs/design/`, refresh the `needs audit` markers in `docs/CODE_MAP.md` and the closing paragraph of `docs/ARCHITECTURE.md`. No `src/` change. |
| 2 | `feat(judgment): schema skeleton` | `migrations/004_judgment_skeleton.sql` (judgment_sources / judgment_items / judgment_evidence_links / judgment_edges / judgment_events). Memory schema unchanged. |
| 3 | `feat(judgment): proposal/commit gate` | `src/judgment/items.ts` + first typed tools (`propose` / `commit` / `supersede`). Enforce `assistant_generated` / `inferred` → proposal-only. |
| 4 | `feat(context): stage 4 compiler` | `src/context/compiler.ts` reads `current_operating_view`. `src/context/builder.ts` stays in tree (kept for regression fixture parity). |
| 5 | `refactor(queue): worker uses compiler` | Replace `worker.ts buildContextForRun` with Compiler call. Queue state machine and terminal commit untouched. |
| 6 | `refactor(memory): Q-027 summary promotion policy` | After Q-027 resolves, change `src/memory/summary.ts promoteItems` so `fact` / `decision` / `open_task` / `caution` go to the judgment proposal layer (or stay in memory under stricter gate). |
| 7 | `refactor(memory): split provenance gate semantics` | Split `mayPromoteToLongTerm` into per-question helpers; rename call sites. |
| 8 | `feat(judgment): control-plane tables (additive)` | `tensions` / `reflection_triage_events` / `interaction_signals` / `critique_outcomes`. New writers; no existing module touched. |
| 9 | `chore(context): remove legacy builder` | After Compiler stabilises, delete `src/context/builder.ts` and update fixtures. |
| 10 | (optional) `chore(memory): jsonl/md sidecar policy` | After §5.3 policy ADR, adjust or remove the sidecar writer in `worker.ts`. |

Steps 2-3 and the Compiler **interface** work in step 4 can begin
in parallel. Step 5 (worker swap) must not merge until a
`current_operating_view`-compatible projection or compatibility
adapter exists — otherwise the worker would read against a
contract that does not yet have a producer. Step 6 cannot start
until Q-027 is closed. Step 9 is the last step that touches the
legacy builder.

## 7. Open questions surfaced by this audit

These are surfaced for `docs/07_QUESTIONS_REGISTER.md` follow-up.

| Question | Note |
|----------|------|
| Q-027 (already open) | `memory_items` ↔ `judgment_items` 통합 / 분리 / 단계적 — the gating decision for steps 4-6 above. |
| Q-064 (promoted 2026-04-27) | Should `mayPromoteToLongTerm` be split into `mayPersistAsMemoryItem` / `mayBecomeBehaviorBaseline` / `mayProposeJudgment`? Code-side counterpart of Q-027. |
| `control_gate_events` vs `control_plane_events` table name | Already noted in JUDGMENT_SYSTEM.md §Implementation Readiness. |
| Q-065 (promoted 2026-04-27) | `memory_base_path` JSONL / MD sidecar policy — archive only, behavior baseline contributor, or removed? Affects step 10 above and AC-MEM-001. |
| Q-066 (promoted 2026-04-27) | At step 9, should `src/context/builder.ts` be deleted in the same PR as Compiler, or marked `possibly stale` first and removed only after one release of soak time? |

## 8. Audit history

- **v1 (initial draft).** Classified `src/queue/worker.ts`,
  `src/memory/summary.ts`, `src/memory/provenance.ts`,
  `src/memory/items.ts` as KEEP. The error: judging
  `worker.ts` (1819 LOC) without inspecting `buildContextForRun`,
  and treating the auto-promotion of fact / decision / open_task
  / caution into `memory_items.status='active'` as a
  memory-internal concern instead of recognising the worker
  re-injection loop.
- **v2 (this document).** External review pointed out that
  `worker.ts` directly imports `buildContext` / `pack`, runs
  `memory_items WHERE status='active'` and `memory_summaries`
  reads inside the worker, and writes the JSONL / MD sidecar.
  The four memory-related modules and `worker.ts` are upgraded
  to ADAPT. `src/context/builder.ts` remains the only REPLACE
  candidate. No DELETE candidates.

## 9. What this audit does not do

- It does not change any code under `src/`, `migrations/`, or
  `test/`. The recommended changes are the follow-up PRs in §6.
- It does not edit any accepted ADR (per DEC-037).
- It does not edit the long P0 design docs (PRD / HLD / etc.).
- It does not write a new ADR. ADR candidates surface in §7 if
  and when the corresponding decisions are taken.
