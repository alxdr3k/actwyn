# ADR-0011 — Architecture Upgradeability and Memory Activation Lifecycle

- Status: accepted
- Date: 2026-04-26
- Supersedes: —
- Superseded by: —

## Context

ADR-0009(DB-native Judgment System)와 ADR-0010(Cognitive Extension)이
actwyn의 judgment system 골격을 codify했다. 사용자가 second-brain
ideation Round 10에서 두 가지 미묘한 질문을 동시에 제기했다.

1. "지금 설계가 미래의 새 연구·논문·가설을 잘 반영할 수 있는 상태인가?"
2. "오래된 기억은 워크스페이스로 안 올린다고 했는데, '오래된'을 어떻게
   식별하는가? 단순 `created_at` 기준? 중요도와 연관되어야 할 듯. 그리고
   '더 이상 유효하지 않은 기억'과는 미묘하게 다른 듯한데..."

GPT-5의 답변은 두 질문이 **같은 lifecycle 문제**임을 보여주었다.

> 새 논문 등장과 "오래된 기억"은 같은 구조다. 둘 다 active → challenged →
> superseded 패턴으로 처리. architecture_assumption도 judgment처럼
> 저장하면 "와 다 갈아엎자"가 아니라 "어떤 module만 교체할지"로 처리
> 가능하다.

> 기억은 오래됐다고 버리는 게 아니라, **현재 판단에서의 활성화 가치
> (activation value)가 낮을 때** 워크스페이스에서 빠진다. 유효하지 않은
> 기억은 삭제되는 게 아니라 superseded/revoked/expired 상태로 역사와
> 근거에 남는다.

ADR-0009의 status 6 enum과 ADR-0010의 cognitive layer만으로는 다음을
다루기 부족했다.

- **dormant**(잠든 — 유효할 수 있으나 현재 task와 relevance 낮음)와
  **stale**(낡은 — 재검증 필요)의 구분.
- 단일 `created_at`이 아닌 **시간 필드 다중화**(observed_at /
  last_verified_at / last_used_at / last_relevant_at).
- 기억 종류별 **decay 차별화**(사용자 명시 선호 vs 마케팅 채널 성과).
- 시스템 자신의 설계 가정(`architecture_assumption`)도 lifecycle을
  가져야 한다는 인식.
- 새 연구 흡수를 위한 **ontology / schema versioning**과 update protocol.

이 결정들을 Phase 0.5+ architectural commitment로 codify하지 않으면,
Phase 1 schema 구현과 Phase 2 typed tool에서 매번 ad-hoc하게 다뤄지고,
나중에 상호 호환되지 않는 forking이 발생할 위험이 크다.

## Decision

actwyn judgment system에 **upgradeability invariants**와 **memory
activation lifecycle**을 codify한다. ADR-0009와 ADR-0010은 그대로
유효하며 supersede되지 않는다 — 본 ADR은 status enum / 시간 필드 /
decay policy / upgradeability hooks를 **확장**한다.

세부 spec은
[`docs/JUDGMENT_SYSTEM.md`](../JUDGMENT_SYSTEM.md) §Upgradeability &
Memory Activation에 single source로 관리한다.

### 9개 핵심 commitment

1. **Architecture invariants 분리.** 고정할 것 7가지(source/event 보존,
   judgment-source-evidence 연결, scope/status/confidence/time,
   supersede/revoke/expire, projection-based current truth, derived
   index, eval) vs 바꿀 수 있게 둘 것 8가지(taxonomy / scoring formula /
   reflection · consolidation · forgetting · decay policy / vector ·
   graph backend / context packing / salience model). 인지 이론을 DB
   schema에 딱딱하게 박지 말고 정책과 backend는 갈아끼울 수 있게 둔다.

2. **Status enum 확장.** ADR-0009의 6 status (`proposed` / `active` /
   `superseded` / `revoked` / `rejected` / `expired`)에 **`dormant` /
   `stale` / `archived` 3개 신규**를 추가한다. `dormant`(유효할 수 있으나
   현재 task와 relevance 낮음)와 `stale`(재검증 필요) 구분이 핵심.
   `rejected`와 `revoked` 통합은 Q-036에서 결정.

3. **시간 필드 5 신규** (모두 optional): `observed_at`,
   `last_verified_at`, `last_used_at`, `last_relevant_at`,
   `superseded_at`/`revoked_at`. ADR-0009의 `created_at` /
   `valid_from` / `valid_until`과 결합하여 기억 종류별 다른 시계를
   지원한다.

4. **`volatility` + `decay_policy` 신규 필드** (모두 optional). volatility
   3 enum (low/medium/high), decay_policy 5 enum (`none` / `time_decay` /
   `verification_decay` / `event_driven` / `supersede_only`). P0.5는
   `none` + `supersede_only`만 도입, 나머지 3종은 P1+ (DEC-027).

5. **`ontology_version` + `schema_version` 강제 필드.** 모든 새 record에
   필수. v0.1로 시작 (`ontology_version: judgment-taxonomy-v0.1`,
   `schema_version: 0.1.0`). 나중에 taxonomy / schema가 바뀌어도 기존
   데이터를 재해석할 수 있게 한다.

6. **`architecture_assumption`을 first-class judgment로.** 시스템 자신의
   설계 가정도 같은 lifecycle (active → challenged → superseded)을
   가진다. 예: "current truth is a projection" / "vector index is not
   canonical" / "GitHub repo is export/import only". 구현 형태(별 type
   vs `kind: 'architecture_assumption'` vs `scope: system`)는 Q-037.

7. **`research_update_protocol` 7단계 프로세스 commitment.**
   capture → extract (LLM) → map to architecture_assumptions → propose
   change → eval (regression/improvement) → migrate (점진적) → supersede
   (기존 assumption status: superseded). P0.5는 사람 검토 + Claude
   proposal 패턴. 자동화는 P2+ (Q-039).

8. **Hard filter + Soft activation score 2단계 workspace inclusion.**
   Hard filter (revoked/superseded/expired 기본 제외, scope mismatch,
   sensitivity 부적절, wrong provenance) → Soft activation score
   (task_relevance + scope_match + importance + confidence +
   user_emphasis + current_goal_match + decision_impact +
   risk_or_caution_boost + recent_verification_boost +
   repeated_use_boost - staleness_penalty - uncertainty_penalty -
   token_cost_penalty). `created_at`은 작은 요소.

9. **Round 9 attention_score → Round 10 activation_score 통합.**
   ADR-0010의 attention_score formula
   (`docs/JUDGMENT_SYSTEM.md` §Attention scoring)는 본 ADR의
   activation_score로 흡수되어 단일 formula가 된다. 두 개 분리 유지하지
   않는다.

## Alternatives considered

- **Status enum 그대로 두고 "old" 추상 개념으로 처리** — 사용자 질문이
  정확히 이걸 거부한다 (oldness ≠ activation, dormant ≠ stale ≠
  invalid).
- **decay_policy를 모두 hardcoded** — 기억 종류별 차이를 못 다룬다 (사용자
  명시 선호와 마케팅 채널 성과는 같은 decay rule이면 안 됨).
- **ontology_version 없이 시작** — taxonomy를 바꿀 때 기존 데이터 마이그레이션
  비용이 폭발한다.
- **architecture_assumption을 별 시스템으로 분리** — judgment ledger와
  동일한 lifecycle 패턴이라 별 시스템으로 분리하면 중복 인프라가 생긴다.
  통합이 단순.
- **attention_score / activation_score 분리 유지** — 두 formula가 거의
  동일 신호를 다른 가중치로 합산. 통합이 더 단순하고 일관됨.

## Consequences

- `docs/JUDGMENT_SYSTEM.md`에 §Upgradeability & Memory Activation 신설
  (Round 10 import). ADR-0010의 §Attention scoring sub-section은 본
  섹션으로 이동/통합.
- Phase 1 schema PR (별 ADR 후보)에서 새 status / 시간 필드 / volatility
  / decay_policy / ontology_version / schema_version 컬럼 추가.
- Phase 1에서 `judgment_items`에 `kind = "architecture_assumption"`
  row를 시드 — ADR-0009 / ADR-0010 / ADR-0011의 commitment를
  architecture_assumption 형식으로 저장.
- Phase 2 typed tool에 activation_score formula 구현. P0.5는
  ADR-0009의 단순 retrieval 우선순위만 사용.
- ADR-0009 / ADR-0010과 정합 유지. ADR-0009의 6 status는 ADR-0011이
  9 status (또는 rejected 통합 시 8 status)로 확장.
- DEC-026 (P0.5 status enum 도입 범위), DEC-027 (decay_policy P0.5
  범위), DEC-028 (ontology_version + schema_version 강제) 신설.
- Q-036 ~ Q-039 신설 (rejected/revoked 통합 / architecture_assumption
  구현 형태 / activation_score 가중치 default / research_update_protocol
  자동화 시점).

## Risks and mitigations

| Risk | Mitigation |
| ---- | ---------- |
| Status enum 확장으로 인한 마이그레이션 비용 | 모든 신규 status는 optional, default `active` 유지. 기존 row는 `schema_version: 0.0`으로 표시하여 본 ADR 도입 전 데이터임을 명시. |
| `ontology_version` 강제로 새 row 작성 friction | typed tool layer에서 자동 주입. `judgment.propose` / `judgment.commit`이 default ontology_version을 채운다. |
| `architecture_assumption`이 application data와 섞일 위험 | `kind` 또는 `scope: system`으로 명확히 구분. retrieval에서 기본 제외 (사용자가 명시 요청 시만 포함). |
| `decay_policy` 5 enum이 over-engineering 위험 | P0.5는 `none` + `supersede_only`만 도입 (DEC-027). 나머지 3종은 P1+에서 evidence 기반 추가. |
| `activation_score` formula가 hot path latency 증가 | precomputed projection으로 일부 항목 (importance / scope_match / staleness) 캐시. ADR-0010의 token discipline (Round 8) 정합. |
| Round 9 attention_score → Round 10 activation_score 전환으로 ADR-0010 본문 일관성 깨짐 | ADR-0010 Refs에 ADR-0011 cross-ref 추가. JUDGMENT_SYSTEM.md §Attention scoring 섹션은 §Upgradeability & Memory Activation으로 통합 표시. |

## Review trigger

- 새 status가 필요할 때 (예: `deprecated`, `challenged`).
- `ontology_version` 변경 시 (taxonomy 재구성).
- `activation_score` formula 가중치 학습 도입 시 (Q-026 / Q-038).
- 새 논문 / 서비스가 architecture_assumption을 challenge할 때
  (research_update_protocol 발동).
- `decay_policy` enum 추가 / 제거 필요 시.
- `rejected` vs `revoked` 통합 결정 시 (Q-036).

## Refs

- Import source: [second-brain Ideation Round 10](https://github.com/alxdr3k/second-brain/blob/main/Ideation/second-brain-as-judgment-layer.md)
  (Round 10 + Appendix A.20.1 ~ A.20.14).
- 본 결정의 architecture spec: [`docs/JUDGMENT_SYSTEM.md`](../JUDGMENT_SYSTEM.md)
  §Upgradeability & Memory Activation.
- ADR-0009 (DB-native Judgment System — status / schema 기본),
  ADR-0010 (Cognitive Extension — attention_score / 시간 필드 일부) —
  모두 확장되며 supersede되지 않음.
- ADR-0003 (SQLite canonical), ADR-0006 (provenance / supersede chain),
  ADR-0008 (durable ledgers) — 정합 유지.
- DEC-024 / DEC-025 (P0.5 cognitive scope, metacognitive 필드 optional) —
  정합 + 보강. DEC-026 / DEC-027 / DEC-028 (본 ADR과 함께 도입).
- Q-027 (memory ↔ judgment 관계) / Q-029 (FTS5 vs sqlite-vec) —
  ontology migration 측면에서 cross-ref. Q-036 / Q-037 / Q-038 / Q-039
  (본 ADR과 함께 도입).
- 외부 근거: Microsoft Event Sourcing pattern (append-only + projection),
  2026 Memory survey (write-manage-read loop), Complementary Learning
  Systems (McClelland 1995 — 빠른 episodic 저장과 느린 semantic
  통합).
- ADR-0012 (Origin/Authority separation + Metacognitive Critique Loop) —
  본 ADR의 Round 11 must-fix #3 commit (`eb9004b`)이 추가했던
  `epistemic_status: system_authored` enum은 ADR-0012가 RETRACT한다.
  origin과 authority 두 축을 한 필드에 섞은 axis conflation. 정정:
  epistemic_status 8 enum 유지 (origin only) + 신규 `authority_source`
  필드 (7 enum, authority 전담). ADR-0011의 다른 commitment는 모두 유효.
- ADR-0013 (Critique Lens v0.1 + Tension Generalization + Status Axis
  Separation) — 본 ADR의 status 9 enum 통합은 partial retract (truth
  lifecycle / activation / retention 3축 섞은 axis conflation 해소).
  3축 분리: lifecycle_status (6) + activation_state (5) +
  retention_state (3). attention_score → activation_score 통합도
  partial retract — 3 score (retrieval / activation / attention_priority)
  로 분리 (P0.5는 단일, P1+ 분리). architecture_assumption은 kind 아니라
  `kind=assumption` + `target_domain=architecture`로 정교화.
