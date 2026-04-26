# ADR-0013 — Critique Lens v0.1 + Tension Generalization + Status Axis Separation

- Status: accepted
- Date: 2026-04-26
- Supersedes: —
- Superseded by: —
- Partial retract of: ADR-0011 §Status enum 통합 (9 enum 단일), ADR-0011
  §attention_score → activation_score 통합, ADR-0012 `DesignTension` 객체
  이름 (→ 일반 `Tension` rename + target_domain 차원 추가)
- Refines: ADR-0010 §Reflection layer (5 sub-action 분해), ADR-0010
  §Workspace 객체 (3축 분리), ADR-0011 §architecture_assumption (kind
  enum 폭발 방지)

## Context

second-brain ideation Round 13에서 사용자가 본인의 5가지 비판 기준으로
전체 설계 처음부터 끝까지 다시 리뷰 요청. 동시에 ADR-0012의
`DesignTension` 객체를 다른 영역 (memory / policy / workflow / evidence /
marketing 등)으로 확장 가능한지 질문.

GPT-5의 답변:

> 5가지 기준은 단순 리뷰 체크리스트가 아니라 actwyn Judgment System의
> **메타인지/비판 루프 핵심 알고리즘**이다. 이름: Critique Lens v0.1.
>
> DesignTension은 확장해야 한다. 다만 MarketingTension / MemoryTension 별
> 테이블 만들면 안 됨. **단일 Tension 객체 + `target_domain` 차원**으로
> 분리해라.
>
> 5 lens로 본 현재 설계는 방향 맞지만 8개 setting (Judgment / status /
> current_truth / Reflection / Workspace / Procedure /
> architecture_assumption / attention·activation·retrieval)에서 용어가
> 넓고 축이 섞이며 시스템화 게이트가 부족하다.

본 ADR은 Round 13의 합의를 codify한다.

## Decision

actwyn judgment system에 **Critique Lens v0.1** + **Tension
Generalization** + **Status Axis Separation** + **8개 setting 정교화**를
도입한다. ADR-0009 / 0010 / 0011 / 0012는 모두 유효하며, 본 ADR은 일부
필드 / enum / 객체 이름을 정정한다 (partial retract / refine).

### 1. Critique Lens v0.1 명시 (5 rule)

actwyn critic loop의 self-applied algorithm:

```
Rule 1. Term compression check
  If term controls storage / retrieval / authority / lifecycle / workspace
  inclusion AND has multiple plausible meanings,
  → create Tension(category = ambiguous_term)

Rule 2. Axis separation check
  If one enum/field is used for two independent implementation decisions,
  → create Tension(category = axis_conflation)

Rule 3. Workflow friction check
  If proposed system requires user workflow they already rejected,
  → create Tension(category = workflow_friction)

Rule 4. Exception probe
  For any rule, test ≥1 exception case.
  If exception needs new state / category / policy,
  → create Tension(category = lifecycle_gap | taxonomy_gap | policy_gap)

Rule 5. Systematization gate
  If tension is recurring / high-impact / implementation-affecting /
  future-bug-prone, promote to tracked Tension.
  Otherwise keep as ephemeral critique telemetry.
```

이 5 rule은 ADR-0012의 LLM critic prompt 8 failure mode와 정합 — 8 mode가
"무엇을 보는가"라면, 5 rule은 "어떻게 처리하는가"이다.

### 2. Tension Generalization (DesignTension → Tension)

ADR-0012의 `DesignTension` 객체는 일반 `Tension`으로 이름 변경 +
`target_domain` 차원 추가. 별 테이블 X.

```ts
type Tension = {
  id: string

  target_domain:    // 신규 차원, 13 enum (Tension과 kind=assumption 공유)
    | "design"            // P0.5
    | "memory"            // P0.5
    | "policy"            // P0.5
    | "workflow"          // P0.5
    | "evidence"          // P0.5
    | "decision"          // P0.5
    | "security"          // P0.5
    | "architecture"      // P0.5 (kind=assumption + target_domain=architecture 위함)
    | "product"           // P1+
    | "marketing"         // P1+
    | "user_preference"   // P1+
    | "research"          // P1+
    | "tooling"           // P1+

  target_type: ...         // ADR-0012 11 enum 그대로
  target_id?: string

  category:                // ADR-0012 11 + Round 13 신규 3 = 14 enum
    | "ambiguous_term" | "axis_conflation" | "authority_confusion"
    | "lifecycle_gap" | "taxonomy_gap" | "policy_gap"            // taxonomy_gap, policy_gap 신규
    | "workflow_friction" | "projection_gap" | "upgradeability_gap"
    | "evidence_conflict"                                         // 신규
    | "scope_mismatch"                                            // 신규
    | "token_cost_risk" | "security_risk" | "eval_gap"

  signal_source:           // ADR-0012 6 + research_update 신규 = 7 enum
    | "user_question" | "user_correction" | "critic_model"
    | "eval_failure" | "telemetry" | "code_review"
    | "research_update"

  evidence_source_ids: string[]
  suspected_issue: string
  why_it_matters: string
  proposed_resolution?: string
  severity: "low" | "medium" | "high"
  confidence: number

  status:                  // ADR-0012 7 + converted_to_eval 신규 = 8 enum
    | "open" | "accepted" | "rejected" | "resolved"
    | "converted_to_question" | "converted_to_decision"
    | "converted_to_eval"  // 신규
    | "converted_to_judgment"

  created_at: string
  resolved_at?: string
}
```

**P0.5 도입**: 6 + security + architecture = 8 target_domain enum.
`architecture`는 `kind=assumption`이 `target_domain=architecture`로 자기
자신을 표현해야 하므로 P0.5 필수 (Round 13 codex bot review 정정).
나머지 5 enum (`product` / `marketing` / `user_preference` / `research` /
`tooling`)은 reserved 또는 string-like + 문서 권장 (DEC-032).

`DesignTension` 테이블은 `Tension` 테이블로 schema rename. ADR-0012의
사용 패턴 (target_id / category / signal_source 등) 모두 정합 유지.

### 3. status 9 enum → 3축 분리 (ADR-0011 partial retract)

ADR-0011은 status 9 enum 단일 통합 (proposed / active / dormant / stale /
expired / superseded / revoked / rejected / archived). Round 13 lens로
보면 truth lifecycle / activation / retention 3축이 섞임 (axis
conflation).

**3축 분리**:

```ts
type JudgmentItem = {
  // ADR-0011 status 9 enum 통합 폐기

  lifecycle_status:        // 진실성/승인/대체 (사람·AI 명시 변경)
    | "proposed" | "active" | "rejected"
    | "revoked" | "superseded" | "expired"   // 6 enum

  activation_state:        // 현재 task에서 workspace 후보? (대부분 projection)
    | "eligible" | "dormant" | "stale"
    | "history_only" | "excluded"            // 5 enum

  retention_state:         // 보존/노출 정책
    | "normal" | "archived" | "deleted"      // 3 enum
}
```

**조합 가능 예시**:
- `active` + `stale` + `normal`: 유효하지만 재검증 필요
- `superseded` + `history_only` + `normal`: 대체됐지만 audit 시 조회
- `active` + `eligible` + `archived`: 유효하지만 장기 보관

P0.5 도입: lifecycle_status 6 enum + activation_state 3 enum (eligible /
history_only / excluded만, dormant / stale 자동 분류는 P1+) +
retention_state 3 enum (DEC-033). DEC-026의 status 9 enum P0.5 도입은
DEC-033으로 supersede.

### 4. `current_truth` → `current_operating_view` 이름 변경

ADR-0009 Law #4 ("Current truth is a projection")의 "truth" 함의가
위험. "진짜 진실"이 아닌 "현재 운영 기준". DB 필드 `current_state`는
유지 (ADR-0009 / 0010과 정합), 문서 / UX는 `current operating view`.

**Projection rules 명시** (ADR-0009 Law #4 보강):

```
Input:
- active current_state
- active decisions
- high-authority procedures (authority_source ∈ user_confirmed /
  maintainer_approved / merged_adr / runtime_config)
- high-confidence user preferences
- active cautions
- relevant architecture assumptions (target_domain=architecture)

Excluded by default:
- lifecycle_status ∈ proposed / rejected / revoked / superseded / expired
- activation_state ∈ history_only / excluded
- retention_state ∈ archived / deleted
- stale without warning (P0.5는 stale 자동 분류 안 함)

Conflict resolution priority:
1. authority_source (compiled_system_policy / safety_policy >
   merged_adr > maintainer_approved > user_confirmed > none)
2. scope specificity (narrower wins)
3. supersede chain (newer wins)
4. last_verified_at (recent wins)
5. confidence (high wins)
6. Unresolved → create Tension(category=evidence_conflict), not current view
```

### 5. Reflection 5 sub-action 분해 (ADR-0010 refine)

ADR-0010의 reflection layer를 5 sub-action으로 분리:

| Sub-action | Plane | P0.5 도입 |
|---|---|---|
| `reflection_triage` | control-plane (ADR-0012 그대로) | ✅ (사용자 명시 trigger) |
| `reflection_proposal` | control-plane | ❌ P1+ |
| `consolidation` | judgment-plane (commit gate) | ❌ P1+ |
| `critique` | control-plane (Tension 생성) | ❌ P1 |
| `eval_generation` | judgment-plane (JudgmentEvalCase) | ❌ P2 |

ADR-0012 §ReflectionTriageEvent는 `reflection_triage`만 처리. 나머지
4 sub-action은 ADR-0013에서 새 control-plane object 또는 typed tool로
정의.

### 6. Workspace 3축 분리 (ADR-0010 refine)

ADR-0010의 `Workspace` 객체를 3축으로 분리:

| 객체 | 의미 | 형태 | P0.5 |
|---|---|---|---|
| `WorkspacePlan` | 어떤 항목 가져올지 결정 (내부 계획) | ephemeral object | ❌ P1+ |
| `ContextPacket` | 모델에 실제 투입 압축 context | ephemeral, prompt 일부 | ❌ P1+ |
| `WorkspaceTrace` | 포함/제외 telemetry | control-plane event | ✅ |

P0.5는 `WorkspaceTrace` 이벤트만 (DB table 아님, `judgment_events` 또는
`provider_run` metadata에 link). `WorkspacePlan` / `ContextPacket`은
ephemeral (in-memory build·discard).

### 7. `procedure_subtype` 5 enum 추가 (ADR-0010 refine)

`kind=procedure` 유지, 신규 `procedure_subtype` 필드:

```ts
procedure_subtype?:
  | "skill"
  | "policy"
  | "preference_adaptation"
  | "safety_rule"
  | "workflow_rule"
```

P0.5 마이그레이션: 기존 `kind=procedure` 노트는 default `procedure_subtype
= skill` (사용자가 명시 변경 가능). DEC-034.

### 8. `architecture_assumption` 정교화 (ADR-0011 refine)

ADR-0011은 `kind=architecture_assumption` first-class judgment 도입.
Round 13 lens: kind enum 폭발 위험 (architecture / marketing / product /
user / research_assumption ...).

**정교화**:
```ts
kind: "assumption"          // 단일 enum
target_domain:              // ADR-0013 Tension target_domain과 동일 enum
  | "architecture" | "marketing" | "product" | "workflow"
  | "policy" | "user_preference" | "security" | ...
```

ADR-0011의 `architecture_assumption` 시드 row 마이그레이션 (Q-59):
`kind = "architecture_assumption"` → `kind = "assumption"`,
`target_domain = "architecture"`.

### 9. attention/activation/retrieval 3 score 분리 (ADR-0011 partial retract)

ADR-0011은 attention_score → activation_score 통합. Round 13 lens: 3층이
하나의 score로 합쳐 디버깅 어려움.

**3 score 분리** (P1+ 도입):

```ts
type RetrievalScore = {
  fts_score: number
  vector_score?: number   // P1+
  graph_score?: number    // P2+
  combined_retrieval_score: number
}

type ActivationScore = {
  // ADR-0011 §A.20.9 formula 그대로
  task_relevance: number
  scope_match: number
  importance: number
  // ... ADR-0011 그대로
  combined_activation_score: number
}

type AttentionPriority = {
  position_rank: number  // 1 = top
  packing_mode: "tiny" | "normal" | "deep" | "audit"
  reason: string
}
```

**P0.5 도입**: 단일 retrieval priority (Round 11 권고대로). 3 score
분리는 P1+ 디버깅 evidence 기반 도입.

## Alternatives considered

- **5 lens를 단일 ADR로 분리** — 5 lens가 critic loop의 일부이므로 다른
  결정과 함께 가는 게 자연스러움. 별 ADR로 분리 X.
- **DesignTension / MarketingTension 별 테이블** — 11 가능 domain × 별
  테이블 = 11 테이블 폭발. target_domain 차원이 단순.
- **status 9 enum 유지 + application 코드에서 분리** — schema에서 axis
  conflation을 표현하면 SQL query / projection 작성이 복잡 (status =
  'active' AND status = 'stale' 동시 표현 불가).
- **`current_truth` 이름 유지** — 사용자 / 외부 reader에 misleading.
  refactor cost는 작음 (DB 필드는 그대로).
- **Reflection / Workspace 분해 P0.5에 모두 도입** — over-engineering.
  P0.5는 triage / Trace만, 나머지는 P1+ evidence 기반.
- **`kind=architecture_assumption` 유지** — 다른 domain assumption (예:
  marketing) 등장 시 `kind=marketing_assumption` 추가 — kind enum 폭발.
  `target_domain` 분리가 단순.

## Consequences

- ADR-0011 partial retract:
  - status 9 enum 통합 → 3축 분리 (lifecycle_status / activation_state /
    retention_state). DEC-026 supersede by DEC-033.
  - attention_score → activation_score 통합 → 3 score 분리 (P0.5는 단일
    score, P1+ 분리).
- ADR-0012 partial refine:
  - `DesignTension` 객체 → 일반 `Tension` 객체로 schema rename +
    target_domain 차원 추가.
  - Tension category 11 → 14 enum (taxonomy_gap / policy_gap /
    evidence_conflict / scope_mismatch 추가).
- ADR-0010 refine:
  - Reflection layer → 5 sub-action 분해.
  - Workspace 객체 → 3축 분리.
  - `procedure` kind에 `procedure_subtype` 5 enum 추가.
- ADR-0011 refine:
  - `kind=architecture_assumption` → `kind=assumption` + `target_domain`.
- ADR-0009 refine:
  - Law #4 ("Current truth is a projection") → "Current operating view
    is a projection". DB 필드 `current_state`는 유지.
- `docs/JUDGMENT_SYSTEM.md`에 §Critique Lens v0.1 + §Tension
  Generalization + §Status Axis Separation 신설.
- DEC-032 ~ DEC-036 신규.
- Q-051 ~ Q-062 신규.

## Risks and mitigations

| Risk | Mitigation |
| ---- | ---------- |
| status 3축 분리로 application 코드 복잡도 증가 | 3축은 직교, SQL filter는 단순 (lifecycle_status='active' AND activation_state IN ('eligible', 'dormant')). projection rule이 복잡도 흡수. |
| Tension target_domain 13 enum P0.5 도입이 over-engineering | DEC-032 — P0.5는 8 enum (design / memory / policy / workflow / evidence / decision / security / architecture)만. 나머지 5 enum은 schema reserved. (`architecture`는 `kind=assumption` enum 공유로 P0.5 필수.) |
| ADR-0012 DesignTension → Tension rename으로 마이그레이션 비용 | ADR-0012 commit `8679544` 이후 schema migration 전이라 실제 row 없음. 문서 정정만으로 충분. |
| `current_truth` → `current_operating_view` 이름 변경으로 ADR-0009 Law #4 문구 변경 | DB 필드 `current_state` 유지 — 코드 / migration 영향 없음. ADR-0009 본문은 ADR-0013 §4로 cross-ref + 정정. |
| Reflection 5 sub-action 분해로 P0.5 scope 확장 | DEC-035 — P0.5는 reflection_triage만. 나머지 4 sub-action은 P1+. |
| `architecture_assumption` 시드 마이그레이션 (ADR-0011) | ADR-0011 commit 시점에 시드 row 없음 (architectural commitment 문서만). Phase 1 schema PR에서 깔끔하게 신규 schema 적용. |
| Critique Lens v0.1을 LLM critic prompt에 모두 포함 시 token cost 폭발 | Q-061 — 5 rule single prompt vs 5 separate critic 호출 trade-off. P1 evidence 기반 결정. |

## Review trigger

- 새 Tension target_domain 추가 필요 시 (현재 12 enum, P0.5 도입 7).
- status 3축 외 새 차원 (예: visibility / acl) 필요 시.
- `current_operating_view` 다른 이름 (예: `active_baseline_view`) 필요 시.
- Reflection 5 sub-action 외 새 sub-action 필요 시.
- Workspace 3축 외 새 객체 (예: `WorkspaceQueue`) 필요 시.
- `procedure_subtype` 5 enum 추가 필요 시.
- `kind=assumption`의 `target_domain` 외 다른 차원 (예: `time_horizon`)
  필요 시.
- 3 score (retrieval / activation / attention) 외 새 score layer 필요 시.

## Refs

- Import source: [second-brain Ideation Round 13](https://github.com/alxdr3k/second-brain/blob/main/Ideation/second-brain-as-judgment-layer.md)
  (Round 13 + Appendix A.23.1 ~ A.23.13).
- 본 결정의 architecture spec: [`docs/JUDGMENT_SYSTEM.md`](../JUDGMENT_SYSTEM.md)
  §Critique Lens v0.1 + §Tension Generalization + §Status Axis Separation.
- ADR-0009 (DB-native Judgment System — Law #4 정정).
- ADR-0010 (Cognitive extension — Reflection 5 sub-action / Workspace
  3축 / procedure_subtype refine).
- ADR-0011 (Architecture upgradeability — status 9 enum 통합 partial
  retract; activation_score 통합 partial retract; architecture_assumption
  → kind=assumption + target_domain refine).
- ADR-0012 (Origin/Authority + Critique Loop — DesignTension → Tension
  rename, target_domain / category 추가).
- DEC-032 ~ DEC-036 (본 ADR과 함께 도입).
- Q-051 ~ Q-062 (본 ADR과 함께 도입).
- 외부 근거: GoF design patterns (axis separation 원칙), ACT-R cognitive
  architecture (origin / authority 분리), CoALA (modular memory 기반
  cognitive loop), Microsoft Event Sourcing (control-plane vs
  judgment-plane 분리 패턴).
