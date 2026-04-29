# Traceability Matrix

> Status: living document · Owner: project lead · Last updated: 2026-04-29
>
> This matrix is the index that connects questions, decisions, and
> source-of-truth artifacts. See
> [`00_PROJECT_DELIVERY_PLAYBOOK.md`](./00_PROJECT_DELIVERY_PLAYBOOK.md)
> §12 for the promotion pipeline.

## How to read this file

Each row links:

- **Q-###** — originating question in
  [`07_QUESTIONS_REGISTER.md`](./07_QUESTIONS_REGISTER.md).
- **Decision** — `DEC-###` in
  [`08_DECISION_REGISTER.md`](./08_DECISION_REGISTER.md) or
  `ADR-####` in [`adr/`](./adr/). `—` means the answer was
  already bound in PRD / HLD with no new ledger entry.
- **PRD §** — where the product requirement lives.
- **HLD §** — where the design consequence lives.
- **Other refs** — Runbook §, AC##, SP-##, etc.

A row is valid when every non-`—` cell points at something that
exists. A broken link is a process bug — repair at the row, not
in the source doc.

## Pipeline map

```
Q-### (07_QUESTIONS_REGISTER)
   ↓
DEC-### (08_DECISION_REGISTER)  or  ADR-#### (adr/)
   ↓
PRD §   HLD §   Runbook §   AC##   SP-##
```

---

## Matrix — questions → decisions → artifacts

| Q       | Title                                                              | Decision      | PRD §                      | HLD §            | Other refs                                    |
| ------- | ------------------------------------------------------------------ | ------------- | -------------------------- | ---------------- | --------------------------------------------- |
| Q-001   | P0 success, measurable                                             | DEC-013       | §17, §18                   | —                | Playbook §5.7, §14; 06_ACCEPTANCE_TESTS       |
| Q-002   | Required observational data                                        | DEC-014       | §14.2                      | §10.3, §13.3     | Appendix D                                    |
| Q-003   | memory / transcript / artifact / summary taxonomy                  | —             | §12, Appendix D            | §5, §11          | Implicit in ADR-0003, ADR-0004, ADR-0006      |
| Q-004   | Long-term memory promotion gate                                    | ADR-0006      | §12.2, §12.3               | §11.3            | AC-MEM-002                                          |
| Q-005   | What `/forget` deletes                                             | DEC-006       | §7, §8.1, Appendix D       | §6.4, §7.x       | AC-MEM-003 (pending)                                |
| Q-006   | Memory corrections (supersede, not overwrite)                      | DEC-007       | §12, Appendix D            | §11.3            | —                                             |
| Q-007   | Attachment default save policy                                     | ADR-0006      | §12.8.3, §13.5             | §9.3             | AC-STO-004, AC-STO-005                                    |
| Q-008   | Where artifact meaning lives                                       | ADR-0004      | §12.8, Appendix D          | §5.2, §6.4, §12  | AC-SEC-002                                          |
| Q-009   | Client-side encryption                                             | DEC-008       | §15                        | §12              | 05_RUNBOOK §9                                 |
| Q-010   | Retention durations                                                | DEC-005       | §12.8.2                    | §12              | 05_RUNBOOK §7                                 |
| Q-011   | BOOTSTRAP_WHOAMI lifecycle                                         | DEC-009       | §8.3                       | §9.2, §16.1      | 05_RUNBOOK §12; AC-TEL-001                          |
| Q-012   | Redaction pattern coverage                                         | DEC-010       | §15                        | §13.2            | AC-SEC-001                                          |
| Q-013   | Sensitive attachments without content inspection                   | ADR-0006      | §12.8.3                    | §9.3             | —                                             |
| Q-014   | Provider-session loss recovery                                     | ADR-0007      | §12.4                      | §8.2, §10.2      | SP-06                                         |
| Q-015   | Parser failure still delivers an answer                            | —             | §16.3                      | §8.3, §7.3       | AC-PROV-005                                          |
| Q-016   | Claude Code side effects as chat runtime                           | ADR-0005      | §11, §15                   | §8.1, §8.4       | SP-05; AC-PROV-003                                   |
| Q-017   | Remember-feedback UX                                               | DEC-011       | §8.4                       | §11              | —                                             |
| Q-018   | Telegram notification noise budget                                 | DEC-012       | §13.3                      | §6.3, §9.4       | —                                             |
| Q-019   | `/status` output contract                                          | DEC-015       | §7, §8.1, §14.1            | —                | —                                             |
| Q-020   | Outbound delivery tracking                                         | DEC-015       | §13.3                      | §6.3, §7.7, §16.1 | 05_RUNBOOK §6                                 |
| Q-021   | Restart user-notification policy                                   | DEC-016       | §8.5, §13.3                | §6.2, §15        | 05_RUNBOOK §4; AC-JOB-002                           |
| Q-022   | `/doctor` quick vs deep                                            | DEC-017       | §8.7                       | §16              | AC-OBS-001                                          |
| Q-023   | S3 degraded endurance                                              | DEC-018       | §8.7                       | §12.5, §16.1     | 05_RUNBOOK §7; AC-STO-001, AC-OBS-001                     |
| Q-024   | Summary generation triggers                                        | DEC-019       | §12.3, §12.5               | §11.1            | —                                             |
| Q-025   | Context packer drop order                                          | —             | §12.5, §12.6               | §10.3            | —                                             |
| Q-026   | Recording usage when provider does not report it                   | —             | §14.3                      | §8.4, §13.3      | —                                             |
| Q-027   | `memory_items` ↔ `judgment_items` 관계 (통합 / 분리 / 마이그레이션)  | ADR-0017 / DEC-039 | §12 (taxonomy)       | §11.3            | ADR-0009 §Risks; ADR-0011 §Decision 6; Q-064 |
| Q-028   | `JudgmentItem.kind` v1 enum 범위                                    | DEC-023       | —                          | —                | ADR-0009 §Risks; second-brain Round 11 must-fix |
| Q-029   | Phase 1 SQLite FTS5 vs sqlite-vec leave-room                       | —             | —                          | —                | ADR-0009 §Risks; future Phase 1 ADR            |
| Q-030   | second-brain repo 기존 정책 문서 처분 (cross-repo)                  | DEC-022 (cross-ref) | —                    | —                | ADR-0009 Phase 0 commitment                    |
| Q-031   | Eval harness 도입 시점 (P0.5 / P2 / P4 단계별)                      | —             | —                          | —                | ADR-0009 §Eval harness; second-brain Round 11 §A.21.3 |
| Q-032   | P0.5 layer 우선순위 (cognitive 12-layer 중)                         | DEC-024       | —                          | —                | ADR-0010 §Phase 재구성                          |
| Q-033   | `procedure` skill library 운영 형태                                 | —             | —                          | —                | ADR-0010 §Skill library                         |
| Q-034   | Attention scoring formula 가중치 (정적 vs 학습)                     | —             | —                          | —                | ADR-0010 §Attention scoring; ADR-0011 §Decision 9 (activation_score 통합) |
| Q-035   | Cognitive analogy의 communication 방식                             | —             | —                          | —                | ADR-0010 §Disclaimers                          |
| Q-036   | `rejected` vs `revoked` status 통합 검토                            | —             | —                          | —                | ADR-0011 §Decision 2; DEC-026                  |
| Q-037   | `architecture_assumption` 구현 형태 (kind / scope / 별 schema)     | ADR-0013      | —                          | —                | ADR-0011 §Decision 6; ADR-0013 §Decision 8 (kind=assumption + target_domain). Q-059가 후속 마이그레이션 추적 |
| Q-038   | `activation_score` formula 가중치 default 값                        | —             | —                          | —                | ADR-0011 §Decision 8/9; Q-034 trace            |
| Q-039   | `research_update_protocol` 7단계 자동화 시점                        | —             | —                          | —                | ADR-0011 §Decision 7                           |
| Q-040   | `last_verified_at` 갱신 trigger                                     | —             | —                          | —                | ADR-0011 §시간 필드 8개                         |
| Q-041   | `volatility` 결정 주체                                              | —             | —                          | —                | ADR-0011 §volatility + decay_policy            |
| Q-042   | `ontology_version` migration 전략                                   | —             | —                          | —                | ADR-0011 §ontology_version + schema_version; DEC-028 |
| Q-043   | Reflection triage critic model 선택                                 | —             | —                          | —                | ADR-0012 §Decision 4                          |
| Q-044   | Critic model output JSON schema                                     | —             | —                          | —                | ADR-0012 §Decision 4                          |
| Q-045   | Doubt signal 한국어 keyword 감지 방법                              | —             | —                          | —                | ADR-0012 §Decision 8                          |
| Q-046   | `Tension` severity 결정 주체 (legacy: DesignTension)                | —             | —                          | —                | ADR-0012 §Decision 7; ADR-0013 (Tension generalization) |
| Q-047   | Critic Loop 4-7단계 자동화 시점                                     | DEC-031       | —                          | —                | ADR-0012 §Decision 9                          |
| Q-048   | `critique_outcomes` artifact link 범위                              | —             | —                          | —                | ADR-0012 §Decision 8                          |
| Q-049   | `Tension` 자기참조 깊이 제한 (legacy: DesignTension)                | ADR-0012      | —                          | —                | ADR-0012 §Risks; ADR-0013 (Tension generalization) |
| Q-050   | Control-plane / judgment-plane DB 분리 정도                         | DEC-030       | —                          | —                | ADR-0012 §Decision 6                          |
| Q-051   | Tension target_domain P0.5 도입 범위                                | DEC-032       | —                          | —                | ADR-0013 §Decision 2                          |
| Q-052   | Tension category 14 enum P0.5 도입 범위                             | —             | —                          | —                | ADR-0013 §Decision 2                          |
| Q-053   | status 3축 분리 시 ADR-0011 partial retract 형식                    | ADR-0013      | —                          | —                | ADR-0013 §Decision 3                          |
| Q-054   | Reflection 5 sub-action P0.5 도입 범위                              | DEC-035       | —                          | —                | ADR-0013 §Decision 5                          |
| Q-055   | Workspace 3축 분리 매핑                                             | —             | —                          | —                | ADR-0013 §Decision 6                          |
| Q-056   | procedure_subtype 마이그레이션 default                              | DEC-034       | —                          | —                | ADR-0013 §Decision 7                          |
| Q-057   | current_truth → current_operating_view 적용 범위                    | DEC-036       | —                          | —                | ADR-0013 §Decision 4                          |
| Q-058   | attention/activation/retrieval 3 score P0.5 도입                    | —             | —                          | —                | ADR-0013 §Decision 9                          |
| Q-059   | architecture_assumption 시드 row 마이그레이션                       | —             | —                          | —                | ADR-0013 §Decision 8                          |
| Q-060   | JudgmentItem 4축 분리 사용자 작성 default                           | —             | —                          | —                | ADR-0013                                      |
| Q-061   | Critique Lens v0.1 LLM critic prompt 형식                           | —             | —                          | —                | ADR-0013 §Decision 1                          |
| Q-062   | Tension target_domain 확장 시점                                     | —             | —                          | —                | ADR-0013 §Decision 2; DEC-032                 |
| Q-063   | docs-structure follow-up PR scope (current-state docs / AGENTS.md / archive) | —    | —                          | —                | DEC-037 §scope clarification                  |
| Q-064   | `mayPromoteToLongTerm` gate를 의미별로 split할까?             | DEC-039       | —                          | —                | ADR-0017; `docs/design/salvage-audit-2026-04.md` §7 |
| Q-065   | `memory_base_path` JSONL/MD sidecar policy                   | —             | —                          | —                | `docs/design/salvage-audit-2026-04.md` §5.3/§7 |
| Q-066   | `src/context/builder.ts` 삭제 timing                         | —             | —                          | —                | `docs/design/salvage-audit-2026-04.md` §6 step 9/§7 |
| Q-067   | actwyn self-improvement task 실행 경계                       | ADR-0016      | —                          | —                | future `src/security/*`, `src/execution/*`, `src/tasks/repo/*`, `src/tasks/deploy/*` |

## Matrix — ADRs → artifacts

| ADR      | Title                                                    | PRD §             | HLD §                   | Other refs                     |
| -------- | -------------------------------------------------------- | ----------------- | ----------------------- | ------------------------------ |
| ADR-0001 | Use Bun + TypeScript for P0                              | Appendix F, §9.4  | —                       | SP-01, SP-07, SP-08            |
| ADR-0002 | Use Telegram long polling                                | §13.1, §8.2       | §9.1, §9.4, §9.5        | SP-02; AC-TEL-004                    |
| ADR-0003 | Use SQLite (WAL) as active state SoT                     | §12.7, Appendix D | §3.1, §5, §6            | SP-01; AC-JOB-003                    |
| ADR-0004 | Use S3 as an artifact archive                            | §12.7, §12.8      | §6.4, §9.3, §12         | SP-08; AC-STO-001, AC-STO-002, AC-OBS-001, AC-STO-003a, AC-STO-003b, AC-STO-004–AC-STO-006 |
| ADR-0005 | Ship Claude as the only P0 provider                      | §5, §11           | §8                      | SP-04, SP-05, SP-06; AC-PROV-003      |
| ADR-0006 | Explicit memory + attachment promotion                   | §12.2, §12.8      | §6.4, §9.3, §11.3       | AC-STO-004, AC-STO-005                     |
| ADR-0007 | Provider session as cache, internal session as truth     | §12.4             | §8.2, §10.2             | SP-06                          |
| ADR-0008 | Durable Telegram inbound / outbound ledgers              | §13               | §6.1, §6.3, §7.1, §9    | SP-02, SP-03; AC-TEL-003, AC-JOB-002, AC-STO-001 |
| ADR-0009 | DB-native, AI-first Judgment System                      | §12 (taxonomy 확장 예정) | §11.3 (judgment layer) | `docs/JUDGMENT_SYSTEM.md`; second-brain Ideation Round 7 + Appendix A |
| ADR-0010 | Cognitive extension of Judgment System                   | §12 (taxonomy 확장 예정) | §11.3                | `docs/JUDGMENT_SYSTEM.md` §Cognitive Architecture Extension; second-brain Ideation Round 9 + Appendix A.19 |
| ADR-0011 | Architecture upgradeability + memory activation lifecycle | §12 (taxonomy 확장 예정) | §11.3                | `docs/JUDGMENT_SYSTEM.md` §Upgradeability & Memory Activation; second-brain Ideation Round 10 + Appendix A.20 |
| ADR-0012 | Origin/Authority separation + Metacognitive Critique Loop | §12 (taxonomy 확장 예정) | §11.3                | `docs/JUDGMENT_SYSTEM.md` §Authority Source + §Metacognitive Critique Loop; second-brain Ideation Round 12 + Appendix A.22; ADR-0011 §Refs (RETRACT system_authored) |
| ADR-0013 | Critique Lens v0.1 + Tension Generalization + Status Axis Separation | §12 (taxonomy 확장 예정) | §11.3                | `docs/JUDGMENT_SYSTEM.md` §Critique Lens v0.1 + §Tension Generalization + §Status Axis Separation; second-brain Ideation Round 13 + Appendix A.23; partial retract ADR-0011 status 9 enum / activation_score 통합; rename ADR-0012 DesignTension → Tension; refine ADR-0010 Reflection / Workspace / procedure |
| ADR-0014 | Bun runtime stack confirmation: cautions, principles, roadmap | —                        | —                       | `docs/RUNTIME.md`; `docs/TESTING.md`; `src/db.ts`; `src/providers/subprocess.ts`; `src/storage/s3.ts` |
| ADR-0015 | control_gate_events append-only ledger                        | —                        | —                       | `migrations/005_control_gate_events.sql`; `src/judgment/control_gate.ts`; `test/db/control_gate_schema.test.ts`; `test/judgment/control_gate.test.ts`; **Phase 1B.1**: runtime-wired via `src/queue/worker.ts` (per non-system `provider_run`); `test/queue/control_gate_telemetry.test.ts` |
| ADR-0016 | Capability-governed internal task runner                      | —                        | —                       | future `src/security/*`, `src/execution/*`, `src/tasks/repo/*`, `src/tasks/deploy/*`; Q-067 |
| ADR-0017 | Judgment-centered memory convergence for MVP                  | §12 (taxonomy 확장 예정) | §11.3                   | Q-027; Q-064; DEC-039; future `src/memory/*` and `src/context/compiler.ts` refactor |
| DEC-038 | Judgment System Phase 1B.1–1B.3 Runtime Wiring (2026-04-28) | —                        | —                       | `src/queue/worker.ts` (1B.1 Control Gate + 1B.2 context injection + 1B.3 commands); `src/context/builder.ts` (`judgment_active` slot); `src/telegram/inbound.ts` (KNOWN_COMMANDS); `test/queue/control_gate_telemetry.test.ts`; `test/context/builder_judgments.test.ts`; `test/queue/judgment_commands.test.ts`; `test/queue/judgment_context_injection.test.ts` |

## Matrix — DECs → artifacts

| DEC     | Title                                                        | PRD §                    | HLD §              | Other refs                   |
| ------- | ------------------------------------------------------------ | ------------------------ | ------------------ | ---------------------------- |
| DEC-001 | Single worker, one provider_run at a time                    | §5, §8.5                 | §3.1, §6.2         | —                            |
| DEC-002 | Redaction is a single-module boundary                        | §15                      | §13                | AC-SEC-001                         |
| DEC-003 | Keep PRD at `docs/PRD.md`                                    | —                        | —                  | Playbook §4                  |
| DEC-004 | Bun.S3Client path-style + AWS SDK fallback                   | §12.7                    | §12                | SP-08; AC-OBS-001                  |
| DEC-005 | Retention durations per class                                | §12.8.2                  | §12                | 05_RUNBOOK §7                |
| DEC-006 | `/forget` command set                                        | §7, §8.1, Appendix D     | §6.4, §7.x         | —                            |
| DEC-007 | Memory correction via supersede + memory_items               | §12, Appendix D          | §11.3              | —                            |
| DEC-008 | Private bucket only in P0                                    | §15                      | §12                | 05_RUNBOOK §9                |
| DEC-009 | BOOTSTRAP_WHOAMI with 30-min auto-expiry                     | §8.3                     | §9.2, §16.1        | 05_RUNBOOK §12; AC-TEL-001         |
| DEC-010 | P0 redaction pattern list                                    | §15                      | §13.2              | AC-SEC-001                         |
| DEC-011 | Remember-feedback footer UX                                  | §8.4                     | §11                | —                            |
| DEC-012 | Notification minimal set                                     | §13.3                    | §6.3, §9.4         | —                            |
| DEC-013 | P0 success = AC pass + 7-day dogfood                         | §17, §18                 | —                  | Playbook §5.7, §14           |
| DEC-014 | Required observational data                                  | §14.2                    | §10.3, §13.3       | Appendix D                   |
| DEC-015 | `/status` output contract                                    | §7, §8.1, §13.3, §14.1   | —                  | 05_RUNBOOK §6                |
| DEC-016 | Restart user-notification policy                             | §8.5, §13.3              | §6.2, §15          | 05_RUNBOOK §4; AC-JOB-002          |
| DEC-017 | `/doctor` single command, typed output                       | §8.7                     | §16                | AC-OBS-001                         |
| DEC-018 | S3 degraded thresholds                                       | §8.7                     | §12.5, §16.1       | 05_RUNBOOK §7; AC-STO-001, AC-OBS-001    |
| DEC-019 | Summary auto-trigger conditions                              | §12.3, §12.5             | §11.1              | —                            |
| DEC-020 | Telegram message chunking at 3,800 chars                     | §8.4                     | §9.4               | —                            |
| DEC-021 | CJK-safer token estimator rule                               | §12.6                    | §10.4              | —                            |
| DEC-022 | second-brain GitHub repo는 actwyn judgment의 canonical 아님    | §12 (taxonomy 확장 예정) | §11.3              | ADR-0009 §1; second-brain Round 7 |
| DEC-023 | `JudgmentItem.kind` v1 enum 범위 (6 enforced + 6 deferred)   | —                        | —                  | ADR-0009 §Risks; Q-028; ADR-0013 §architecture_assumption (assumption 추가) |
| DEC-024 | P0.5 cognitive scope (Goal / Workspace / Reflection 최소형)  | —                        | —                  | ADR-0010 §Phase 재구성; Q-032; **Reflection clause superseded by DEC-035** |
| DEC-025 | JudgmentItem metacognitive 필드 P0.5 optional 도입           | —                        | —                  | ADR-0010 §Decision 3          |
| DEC-026 | `JudgmentItem.status` enum P0.5 9 enum 모두 schema 도입 (**superseded by DEC-033**) | —          | —                  | ADR-0011 §Decision 2; Q-036; ADR-0013 §Decision 3 |
| DEC-027 | `decay_policy` enum P0.5는 `none` + `supersede_only`만        | —                        | —                  | ADR-0011 §Decision 4          |
| DEC-028 | `ontology_version` + `schema_version` 모든 새 record에 강제   | —                        | —                  | ADR-0011 §Decision 5; Q-042    |
| DEC-029 | `system_authored` 제거 + `authority_source` P0.5 도입 범위    | —                        | —                  | ADR-0012 §Decision 1-3; ADR-0011 §Refs (system_authored RETRACT cross-ref); second-brain Round 12 사용자 직접 발견 (no upstream Q) |
| DEC-030 | Control-plane vs Judgment-plane 분리                          | —                        | —                  | ADR-0012 §Decision 6           |
| DEC-031 | Critic Loop P0.5 도입 단계 (1-3단계만)                        | —                        | —                  | ADR-0012 §Decision 9; Q-047    |
| DEC-032 | Tension `target_domain` P0.5 도입 범위 (8 enum, architecture 포함) | —                        | —                  | ADR-0013 §Decision 2; Q-051    |
| DEC-033 | `status` 9 enum → 3축 분리 (lifecycle / activation / retention) | —                        | —                  | ADR-0013 §Decision 3; **supersedes DEC-026** |
| DEC-034 | `procedure_subtype` 5 enum + default `skill`                  | —                        | —                  | ADR-0013 §Decision 7; Q-056    |
| DEC-035 | Reflection 5 sub-action P0.5 도입 (`reflection_triage`만)     | —                        | —                  | ADR-0013 §Decision 5; Q-054    |
| DEC-036 | `current_truth` → `current_operating_view` 이름 변경          | —                        | —                  | ADR-0013 §Decision 4; Q-057    |
| DEC-037 | Implementation Documentation Lifecycle Policy                  | —                        | —                  | ADR README §Promotion rules; Q-063 (follow-up docs-structure PR) |
| DEC-038 | Judgment System Phase 1B.1–1B.3 Runtime Wiring (2026-04-28)  | —                        | —                  | `src/queue/worker.ts`; `src/context/builder.ts`; `src/telegram/inbound.ts`; Phase 1B tests |
| DEC-039 | MVP memory-to-judgment convergence implementation posture      | §12 (taxonomy 확장 예정) | §11.3              | ADR-0017; Q-027; Q-064; future `src/memory/*` and `src/context/compiler.ts` refactor |

## Matrix — PRD acceptance criteria → evidence

| AC   | Title                                                               | Decision(s) driving it     | Spike(s) backing it    |
| ---- | ------------------------------------------------------------------- | -------------------------- | ---------------------- |
| AC-TEL-001 | Unauthorized user produces no job                                   | DEC-009                    | SP-02                  |
| AC-JOB-001 | Authorized DM creates one job, transitions cleanly                  | DEC-001                    | SP-01, SP-04, SP-06    |
| AC-PROV-001 | Redacted raw events persisted                                       | DEC-002, DEC-010           | SP-04                  |
| AC-TEL-002 | Final response sent + saved as turn                                 | ADR-0008                   | SP-02, SP-04           |
| AC-TEL-003 | Duplicate `update_id` → one job                                     | ADR-0008                   | SP-03                  |
| AC-JOB-002 | Restart reconciles running jobs                                     | DEC-016                    | SP-01, SP-07           |
| AC-MEM-001 | `/summary`, `/end` produce summary + sync                           | DEC-019                    | SP-06, SP-08           |
| AC-STO-001 | S3 outage doesn't block delivery                                    | ADR-0004, DEC-018          | SP-08                  |
| AC-PROV-002 | Runtime/output/prompt limits terminate subprocess                   | —                          | SP-07                  |
| AC-SEC-001 | Secrets never appear in persisted rows                              | DEC-002, DEC-010           | SP-04, SP-05           |
| AC-PROV-003 | Claude runs without interactive prompts                             | ADR-0005                   | SP-05                  |
| AC-STO-002 | `storage_sync` failure doesn't roll back                            | ADR-0004                   | SP-08                  |
| AC-MEM-002 | Summary items carry provenance and confidence                       | ADR-0006                   | SP-06                  |
| AC-PROV-004 | `/cancel` terminates whole subprocess group                         | —                          | SP-07                  |
| AC-PROV-005 | Parser fixture normalizes to `final_text`                           | —                          | SP-04                  |
| AC-OBS-001 | `/doctor` S3 smoke passes                                           | DEC-017, DEC-018           | SP-08                  |
| AC-TEL-004 | Long polling without bot framework                                  | ADR-0002                   | SP-02                  |
| AC-PROV-006 | Provider subprocess terminates by timeout / abort                   | —                          | SP-07                  |
| AC-JOB-003 | WAL + atomic claim holds across restart                             | ADR-0003                   | SP-01                  |
| AC-OPS-001 | Dependency list within allowlist                                    | ADR-0001                   | —                      |
| AC-STO-003a | Telegram attachment inbound metadata (Phase 1, no network I/O)     | ADR-0004, ADR-0008         | SP-02, SP-03           |
| AC-STO-003b | Worker capture pass populates bytes / hash / MIME (Phase 2)        | ADR-0004                   | SP-02, SP-08           |
| AC-STO-004 | Attachment stays `session` without save intent                      | ADR-0006                   | SP-02                  |
| AC-STO-005 | Explicit save promotes to `long_term`                               | ADR-0006                   | SP-02, SP-08           |
| AC-SEC-002 | S3 keys carry no user-facing semantics                              | ADR-0004                   | SP-08                  |
| AC-STO-006 | `storage_sync` failures retain state cleanly                        | ADR-0004                   | SP-08                  |
| AC-MEM-003 | `/forget_*` uses tombstones, never hard-deletes                     | DEC-006                    | SP-08                  |
| AC-MEM-004 | User correction supersedes prior item atomically                    | DEC-007                    | SP-01                  |
| AC-OBS-002 | Only notification minimal set is pushed                             | DEC-012                    | SP-02                  |
| AC-OBS-003 | `/status` output matches §14.1 contract                             | DEC-015                    | —                      |
| AC-MEM-005 | Summary auto-trigger respects conditions + throttle                 | DEC-019                    | —                      |
| AC-OPS-002 | `/doctor` exposes exact Bun version + mismatch warning              | ADR-0001                   | SP-01                  |
| AC-TEL-005 | Offset advance only after SQLite commit                             | ADR-0008                   | SP-03                  |
| AC-TEL-006 | Crash before commit → update reprocessed                            | ADR-0008                   | SP-01, SP-03           |
| AC-PROV-007 | `resume_mode` does not replay recent turns                         | ADR-0007                   | SP-06                  |
| AC-PROV-008 | Resume failure → `replay_mode` fallback recorded                   | ADR-0007                   | SP-06                  |
| AC-NOTIF-001 | `sendMessage` failure does not roll back `provider_run`           | ADR-0008                   | SP-02                  |
| AC-OPS-003 | `notification_retry` and `storage_sync` retry independently         | DEC-018                    | SP-02, SP-08           |
| AC-PROV-009 | `/provider` returns `not_enabled` in P0                            | ADR-0005                   | —                      |
| AC-TEL-007 | `telegram_updates` records all inbound states                      | ADR-0008                   | SP-03                  |
| AC-TEL-008 | Skipped updates advance offset only after commit                   | ADR-0008                   | SP-03                  |
| AC-TEL-009 | `allowed_updates=["message"]` enforced                             | ADR-0002                   | SP-02                  |
| AC-PROV-010 | `proc.exited` tracking, no `proc.unref()`                          | ADR-0001                   | SP-07                  |
| AC-SEC-003 | Claude advisory lockdown smoke test                                 | ADR-0005                   | SP-05                  |
| AC-SEC-004 | Claude read-only lockdown smoke test                                | ADR-0005                   | SP-05                  |
| AC-SEC-005 | Interactive permission prompt = P0 acceptance fail                  | ADR-0005                   | SP-05                  |
| AC-SEC-006 | `BOOTSTRAP_WHOAMI=true` surfaces `/doctor` warning                  | DEC-009                    | —                      |
| AC-SEC-007 | Bootstrap `/whoami` returns minimal info                            | DEC-009                    | —                      |
| AC-NOTIF-002 | Long response chunking in order                                    | DEC-020                    | SP-02                  |
| AC-NOTIF-003 | Chunk failure retried without resending sent chunks                | DEC-020                    | SP-02                  |
| AC-NOTIF-004 | `outbound_notifications` + chunk ledger tracked                    | DEC-020                    | SP-02                  |
| AC-NOTIF-005 | `notification_retry` selects eligible chunks only                  | DEC-020                    | SP-02                  |
| AC-PROV-011 | Command builder uses `--session-id` then `--resume`                | ADR-0007                   | SP-06                  |
| AC-PROV-012 | `provider_session_id` priority on resume                           | ADR-0007                   | SP-06                  |
| AC-PROV-013 | Argv / prompt length guard                                         | —                          | SP-05, SP-07           |
| AC-PROV-014 | `summary_generation` uses advisory lockdown                         | ADR-0005                   | SP-05                  |
| AC-MEM-006 | `summary_generation` output matches `memory_summaries` schema      | ADR-0006                   | SP-06                  |
| AC-OPS-004 | WAL-safe DB backup if implemented                                   | ADR-0003                   | SP-01                  |
| AC-SEC-ATTACH-001 | Attachment `original_filename_redacted` respects §15 patterns | DEC-002, DEC-010           | SP-04                  |

## Orphan / broken-link check

Run this list after every doc change:

- Every `decided` Q-### has a non-empty `Decision` + `Impacted docs`
  field in `07_QUESTIONS_REGISTER.md`.
- Every `DEC-###` in `08_DECISION_REGISTER.md` has a non-empty
  `Impacted docs` field that points to a real PRD / HLD / Runbook
  / AC location.
- Every ADR status `accepted` has at least one row in the matrix
  above.
- Every PRD AC referenced in the matrix exists in PRD §17.
- Every HLD § referenced in the matrix exists in
  `02_HLD.md`.

When any check fails, fix the matrix first, then the affected
register entry, then the source-of-truth doc — in that order.
