# ADR-0012 — Origin/Authority Separation and Metacognitive Critique Loop

- Status: accepted
- Date: 2026-04-26
- Supersedes: —
- Superseded by: —
- Partial retraction of: ADR-0011 implicit must-fix #3 (`system_authored` enum addition)
- **Partially retracted by**: ADR-0013 — (a) `DesignTension` 객체 →
  generalized `Tension` (single table + `target_domain` 차원), (b) `Tension.status`
  단일 enum → `lifecycle_status` + `resolution_type` 분리, (c)
  `epistemic_status` 필드명 → `epistemic_origin` rename, (d) `approval_state`
  enum (`proposed` / `accepted` / `active` / `rejected`) → `not_required` /
  `pending` / `approved` / `rejected`로 cleanup. 본 ADR 본문의 schema는
  Round 12 시점의 commit이며, **현재 spec은 `docs/JUDGMENT_SYSTEM.md` +
  ADR-0013을 source of truth**로 본다.

## Context

second-brain ideation Round 11에서 PR #10 종합 리뷰의 must-fix #3로
`system_authored`를 `epistemic_status` enum에 추가하라는 권고가 있었고,
ADR-0011 적용 commit (`eb9004b`)에서 이를 적용했다. 사용자가 즉시 모순을
발견했다.

> "system_authored가 뭐야? AI가 생성한 내용이야? 그럼 policy/procedure를
> system_authored로 넣을 수 있다는 얘기는 앞뒤가 안 맞아. AI가 아니라
> 진짜 '시스템'이 작성한 거야? 그럴 수가 있나?"

근본 진단: **`epistemic_status`라는 한 필드가 origin과 authority 두 축을
섞으려 했다**. 이는 axis conflation의 전형 예시.

추가로 사용자가 두 가지 더 질문했다.

1. Reflection을 모든 turn 자동 수집하지 않고 사용자 trigger로 바꾼 건
   좋지만, actwyn이 reflection할지 스스로 판단하는 게 가능한가? (자기참조
   위험)
2. 사용자가 미묘한 의문점·틀린 지점을 발견하는 능력을 actwyn에 이식
   가능한가? actwyn telemetry 설계가 이 작업을 충분히 커버하는가? 부족하면
   그 설계도 수정해야 한다.

GPT-5의 답변은 세 질문이 같은 방향임을 보여주었다.

> actwyn은 "좋은 기억을 저장하는 시스템"을 넘어서, **애매한 개념 / 틀린
> 축 / 과도한 일반화 / 설계 마찰을 스스로 감지하는 시스템**이 되어야 한다.

본 ADR은 (1) Round 11 must-fix #3 정정, (2) reflection triage layer 명시,
(3) 사용자 비판 패턴 시스템화 (Metacognitive Critique Loop)를 한 결정으로
묶는다. ADR-0009 / ADR-0010 / ADR-0011은 모두 유효하며, 본 ADR은 schema
필드 추가 + 신규 control-plane object를 codify한다.

## Decision

actwyn judgment system에 **Origin/Authority separation**과 **Metacognitive
Critique Loop**를 도입한다. 핵심 commitment 8개.

### 1. `system_authored` 제거 (Round 11 must-fix #3 RETRACTION)

`JudgmentItem.epistemic_status` enum에서 `system_authored`를 제거한다.
ADR-0011 적용 commit `eb9004b`이 추가했던 9 enum은 다시 8 enum으로
되돌린다 (`observed` / `user_stated` / `user_confirmed` / `inferred` /
`assistant_generated` / `tool_output` / `decided` / `deprecated`).

`epistemic_status`는 **origin only** — 내용이 어디서 왔는가.

### 2. `authority_source` 신규 필드 (7 enum, optional)

내용의 권위 근거를 표현하는 별 필드를 신설한다.

| Authority Source | 의미 |
|---|---|
| `none` | 권위 없음 (proposal 단계) |
| `user_confirmed` | 사용자 명시 확인 |
| `maintainer_approved` | maintainer (사용자 본인) 승인 — PR review 통과 |
| `merged_adr` | ADR 형태로 머지됨 |
| `runtime_config` | 배포 config (env / config file) |
| `compiled_system_policy` | 컴파일된 시스템 규칙 (소스코드 / migration / hard-coded policy) |
| `safety_policy` | 안전 정책 (OWASP invariant 등) |

`compiled_system_policy`는 "시스템이 생각해서 쓴 내용"이 아니라 **배포된
프로그램 자체에 포함된 규칙**이다.

### 3. `approval_state` + `approved_by` + `approved_at` 신규 필드

approval workflow를 표현:

```ts
approval_state?: "proposed" | "accepted" | "active" | "rejected"
approved_by?: "user" | "maintainer" | "system_release"
approved_at?: string
```

### 4. Reflection은 control-plane triage layer

actwyn (또는 별 critic model)이 reflection 후보 판단까지만 수행한다.
durable judgment commit은 별 gate를 거친다. 절대 안 되는 구조:

```
대화 종료 → LLM이 reflection 생성 → 바로 memory/judgment commit
```

좋은 구조:

```
이벤트 발생
  → reflection triage (control-plane)
  → reflection proposal 생성 여부 판단
  → proposal queue
  → provenance / authority gate
  → 필요 시 user confirmation 또는 maintainer approval
  → commit
```

critic model 사용 가능 (오히려 추천). 출력은 constrained JSON, `commit_allowed:
false` 강제.

### 5. `ReflectionTriageEvent` (control-plane object)

```ts
type ReflectionTriageEvent = {
  id: string
  source_turn_ids: string[]
  trigger_type:
    | "explicit_user_memory_request"
    | "correction"
    | "decision_signal"
    | "conceptual_tension"
    | "repeated_confusion"
    | "architecture_assumption_challenged"
    | "high_salience_user_signal"
  should_reflect: boolean
  suggested_reflection_type?: string
  reason: string
  confidence: number
  created_at: string
}
```

durable judgment가 아니라 control-plane event. judgment-plane과 명시적으로
분리한다.

### 6. Control-plane vs Judgment-plane 구분 commitment

```
control-plane (telemetry / audit / debug):
  reflection_triage_event
  workspace_build_event (ADR-0010)
  retrieval_debug_event
  context_pack_event
  interaction_signal              (신규)
  design_tension                  (신규)
  critique_outcome                (신규)

judgment-plane (durable, 행동 기준):
  decision / current_state / caution / procedure / principle
  fact / preference (ADR-0009 11 conceptual kinds)
```

이 분리 없이 critique를 judgment로 저장하면 "자기 판단의 판단의 판단"
recursive swamp.

### 7. `DesignTension` 객체 신설 (Metacognitive Critique Loop)

사용자가 미묘한 오류를 발견하는 능력을 시스템화. judgment 아닌 **critique**
객체.

```ts
type DesignTension = {
  id: string
  target_type:
    | "judgment_item" | "schema_field" | "tool_contract"
    | "doc_section" | "architecture_assumption" | "workflow"
  target_id?: string
  category:
    | "axis_conflation"        // Round 12 system_authored 자체가 예시
    | "ambiguous_term"         // Round 10 "오래된 기억"이 예시
    | "scope_creep"
    | "workflow_friction"      // Round 7 GitHub PR write-back 거부
    | "authority_confusion"
    | "lifecycle_gap"
    | "upgradeability_gap"     // Round 10 새 논문 흡수성
    | "token_cost_risk"        // Round 8 token discipline
    | "security_risk"
    | "projection_gap"
    | "eval_gap"
  signal_source:
    | "user_question" | "user_correction" | "critic_model"
    | "eval_failure" | "telemetry" | "code_review"
  evidence_source_ids: string[]
  suspected_issue: string
  why_it_matters: string
  proposed_resolution?: string
  severity: "low" | "medium" | "high"
  confidence: number
  status:
    | "open" | "accepted" | "rejected" | "resolved"
    | "converted_to_judgment" | "converted_to_question" | "converted_to_decision"
  created_at: string
  resolved_at?: string
}
```

결과는 open question / doc fix / schema change / eval case / supersede /
no-op.

### 8. 4 신규 telemetry tables (control-plane)

- `interaction_signals` — 대화 중 signal 캡처 (8 signal_type:
  confusion / correction / doubt / friction / overwhelm /
  strong_preference / conceptual_challenge / scope_pushback)
- `reflection_triage_events` — §5 참조
- `design_tensions` — §7 참조
- `critique_outcomes` — 의문 → 결과 추적 (no_change / doc_fix /
  schema_change / tool_contract_change / new_eval_case /
  new_open_question / decision_superseded)

### 9. Critic Loop 8단계 (process commitment)

1. capture (turn / 문서 / tool output / PR review를 ledger 저장)
2. signal detection (correction / doubt / friction / ambiguity / overload)
3. tension proposal (DesignTension 후보 생성)
4. target linking (어떤 schema / judgment / ADR / tool contract 겨냥?)
5. severity ranking (구현 / 보안 / scope creep / token cost / friction)
6. resolution path (open question / doc fix / schema change / eval case /
   supersede / no-op)
7. outcome tracking (실제 PR / 문서 / 결정으로 이어졌는지)
8. learning (자동 감지 heuristic으로 승격)

P0.5는 1-3단계만, 나머지는 P1+ 점진 도입 (DEC-031).

## Alternatives considered

- **`system_authored` 유지하고 의미 재정의** — 사용자 모순 지적이 정확.
  re-define으로는 origin/authority 혼합이 풀리지 않음.
- **`authority_source`를 `epistemic_status`의 별 prefix로 표현 (예:
  `assistant_generated_with_merged_adr`)** — enum 폭발 (8 × 7 = 56). 두
  필드로 분리가 단순.
- **DesignTension을 일반 `JudgmentItem.kind = "design_tension"`으로** —
  judgment-plane과 control-plane 혼합. recursive critique 위험.
- **Reflection을 main model이 직접 commit** — memory poisoning /
  hallucinated preference 위험. ADR-0009 invariant 위반.
- **사용자 비판 패턴 시스템화는 P1+로 미룸** — 이미 12 라운드 토론에서
  반복적으로 발견된 패턴. P0.5에 minimum skeleton 도입이 안전.

## Consequences

- ADR-0011 적용 commit `eb9004b`의 `system_authored` enum 추가는 RETRACTED.
  `JUDGMENT_SYSTEM.md` §Enum catalog에서 system_authored 제거, security
  invariants의 system-authored 표현도 authority_source로 정정.
- `JUDGMENT_SYSTEM.md`에 §Authority Source + §Metacognitive Critique Loop
  + §Reflection Triage Layer 신설 (Round 12 import).
- Phase 1 schema PR (별 ADR 후보)에서 `authority_source` / `approval_state`
  / `approved_by` / `approved_at` 컬럼 추가. `interaction_signals` /
  `reflection_triage_events` / `design_tensions` / `critique_outcomes`
  4 신규 control-plane table.
- DEC-029 (system_authored 제거 + authority_source P0.5 범위), DEC-030
  (control-plane vs judgment-plane 분리 commitment), DEC-031 (Critic
  Loop P0.5 도입 단계).
- Q-043 ~ Q-050 신설.
- ADR-0009 / ADR-0010 / ADR-0011 모두 유효 — 본 ADR은 필드 추가 + 신규
  control-plane object만.

## Risks and mitigations

| Risk | Mitigation |
| ---- | ---------- |
| `authority_source` 7 enum이 over-engineering | DEC-029 — P0.5는 `none` + `user_confirmed`만, 나머지 5 enum은 P1+ evidence 기반 추가 |
| `epistemic_status`와 `authority_source` 두 필드 중복 위험 | epistemic_status는 origin only (where), authority_source는 authority only (why active). 두 축이 명시적으로 다름. |
| Critic model이 hallucination하여 false-positive DesignTension 양산 | 출력 constrained JSON + `commit_allowed: false` 강제 + severity threshold + 사용자 / maintainer 검토 |
| DesignTension이 자기 자신 (axis_conflation 카테고리)에 빠질 위험 (recursive) | 깊이 제한 1 — DesignTension on DesignTension 금지, target_type에 design_tension 제외 |
| 4 신규 telemetry table이 storage 폭발 | retention class 기본 `session` (`ReflectionTriageEvent` / `interaction_signals`), `long_term` (`design_tensions` / `critique_outcomes`). PRD §12.8.2 retention 정합. |
| Reflection triage가 main model 호출 횟수 폭발 | critic model은 별 cheap model (Claude Haiku 후보, Q-043). main model self-critique 권장 안 함 |
| `compiled_system_policy` authority가 어떻게 발생하는지 절차 부재 | Phase 1 typed tool에서 system release 시점에 `judgment.commit` with `authority_source: compiled_system_policy` 명시. 자동 주입 안 됨. |

## Review trigger

- 새 `epistemic_status` 또는 `authority_source` enum 추가 필요 시.
- DesignTension `category` enum 추가 시 (현재 11 enum).
- `interaction_signal.signal_type` enum 추가 시 (현재 8 enum).
- Critic model 변경 시 (Claude Haiku → 다른 cheap model 또는 main model
  self-critique).
- `compiled_system_policy` 자동 발생 vs 명시 commit 결정 시.
- DesignTension 깊이 제한 변경 (1 → 2) 검토 시.

## Refs

- Import source: [second-brain Ideation Round 12](https://github.com/alxdr3k/second-brain/blob/main/Ideation/second-brain-as-judgment-layer.md)
  (Round 12 + Appendix A.22.1 ~ A.22.16).
- 본 결정의 architecture spec: [`docs/JUDGMENT_SYSTEM.md`](../JUDGMENT_SYSTEM.md)
  §Authority Source + §Metacognitive Critique Loop.
- ADR-0009 (DB-native Judgment System — invariant "assistant_generated /
  inferred 자동 commit 금지" 정합 유지).
- ADR-0010 (Cognitive extension — Reflection layer P0.5 도입의 정교화).
- ADR-0011 (Architecture upgradeability — `system_authored` enum 추가는
  본 ADR이 RETRACT).
- DEC-029 / DEC-030 / DEC-031 (본 ADR과 함께 도입).
- Q-043 ~ Q-050 (본 ADR과 함께 도입).
- 외부 근거: 2026 Memory Poisoning 연구 (memory poisoning 차단 논거),
  OWASP AI Agent Security (control-plane vs judgment-plane 분리).
- ADR-0013 (Critique Lens v0.1 + Tension Generalization + Status Axis
  Separation) — 본 ADR의 `DesignTension` 객체는 일반 `Tension`으로
  schema rename + `target_domain` 차원 추가 (12 enum, P0.5 7 enum).
  category 11 → 14 enum (taxonomy_gap / policy_gap / evidence_conflict /
  scope_mismatch 신규). 본 ADR의 Critic Loop 8단계와 ADR-0013의 Critique
  Lens v0.1 (5 rule)은 정합 — 8 mode가 "무엇을 보는가", 5 rule이 "어떻게
  처리하는가".
