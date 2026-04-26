# ADR-0010 — Cognitive Extension of Judgment System

- Status: accepted
- Date: 2026-04-26
- Supersedes: —
- Superseded by: —
- **Refined by**: ADR-0013 — (a) Reflection layer 5 sub-action 분해
  + P0.5 scope narrowed to `reflection_triage` only (no automatic
  lesson candidate append), (b) Workspace 객체 3축 분리 (`WorkspacePlan`
  / `ContextPacket` / `WorkspaceTrace`; P0.5는 `workspaces` table
  도입 안 함, `WorkspaceTrace` 이벤트만), (c) `procedure_subtype` 5
  enum 추가. 본 ADR 본문은 Round 9-10 시점의 commit이며, 현재 운영
  spec은 `docs/JUDGMENT_SYSTEM.md`를 source of truth로 본다.

## Context

ADR-0009 + [`docs/JUDGMENT_SYSTEM.md`](../JUDGMENT_SYSTEM.md)는 actwyn
Judgment System의 1차 architectural commitment(canonical store /
typed tool / 12 Laws / 5 schema / 8 tool / eval harness)를 codify했다.
그러나 그 직후 second-brain ideation Round 9에서 사용자가 새로운
차원의 질문을 던졌다.

> "사실 내가 지금 하려는건 어떻게 보면 인간의 기억 / 사고 / 판단
> 체계를 완성도 높게 모방하려는 것 같아. 지금 방향과 설계가 그
> 목표를 달성하기 위해 충분한 것 같아? 더 개선이 필요한 부분이
> 있을까?"

GPT-5 Round 9 답변의 골자는 다음과 같다.

- 현 ADR-0009 설계는 **memory substrate**으로는 좋지만, 인간 인지에
  비유하면 **cognitive judgment system**으로는 부족하다.
- 인간 인지 기능 10종(episodic / semantic / procedural / working
  memory, attention, value-affect, metacognition, consolidation,
  forgetting-decay, active inference)에 대해 현 설계는 episodic /
  semantic / supersede 부분만 강하다. 나머지가 빈약하다.
- 따라서 framing 자체를 **judgment system → cognitive architecture**로
  확장해야 한다. ADR-0009를 supersede하지 않고 **확장**하는 형태로
  codify해야 다음 schema PR / typed tool 구현 시 전제 충돌이 다시
  발생하지 않는다.

이 결정을 ADR로 codify해야 하는 이유는 promotion rule 3가지(아키텍처
영향 / 다중 모듈 reversal cost / PRD-HLD만 보고 추론 불가능) 모두에
해당하기 때문이다. JudgmentItem schema 확장, Goal / Workspace 같은
신규 first-class 객체, Phase 재구성은 모두 단순 DEC로 담기에는 영향
범위가 넓다.

본 ADR은 _engineering approximation_을 codify한다. 인간 인지의
biological replica를 만드는 것이 목표가 아니다. consciousness /
emotion / intuition을 복제할 의도도 없다. 단지 cognitive science
프레임을 통해 빠진 layer를 surface하고 actwyn judgment system이
실제 사용자 패턴(다회차 ideation → 결정 → 실행 → 반성 루프)을 더
잘 지지하도록 한다.

## Decision

ADR-0009 위에 **7가지 cognitive 확장 commitment**를 추가한다.
ADR-0009의 7개 핵심 commitment(canonical store / typed tool / 12 Laws
/ schema / vector-graph projection / second-brain non-canonical / Law
list)는 **모두 그대로 유효**하다.

1. **Judgment System을 cognitive architecture로 framing 확장.** 단순
   memory store가 아니라 cognitive loop. Loop 단계는
   **capture → attend → retrieve → deliberate → decide → act →
   observe → reflect → consolidate**. 각 단계는
   [`docs/JUDGMENT_SYSTEM.md`](../JUDGMENT_SYSTEM.md) §Cognitive
   Architecture Extension에서 spec으로 codify.

2. **6개 cognitive layer 신설(또는 명시적 식별).** 기존 12-layer
   카탈로그를 codify하되, P0.5 도입 layer는 6개로 한정.
   - Working Memory / Workspace (P0.5 최소형)
   - Goal / Value Layer (P0.5 최소형)
   - Reflection / Consolidation Layer (P0.5 최소형)
   - Attention / Retrieval Layer (P1)
   - Active Inference / Experiment Layer (P1)
   - Forgetting / Decay / Consolidation policies (P1)

   나머지 layer(Event Memory / Episodic / Semantic / Judgment Ledger /
   Procedural / Evaluation)는 ADR-0009 안에 이미 있다.

3. **JudgmentItem schema 확장.** ADR-0009의 schema는 그대로 유지하고
   다음 필드를 **모두 optional**로 추가한다(P0.5 schema PR에서 enum
   값만 지정, 강제는 하지 않음). value / salience: `stakes` /
   `risk` / `valence?` / `user_emphasis?`. metacognition:
   `confidence_reason` / `missing_evidence` / `would_change_if` /
   `review_trigger` / `uncertainty_notes`. (`importance`는 ADR-0009에
   이미 있음 — 본 ADR은 의미만 강화.)

4. **신규 first-class 객체 3개 도입.**
   - **Goal** — id / statement / priority / horizon(now / week /
     month / long_term) / status(active / paused / done).
   - **DecisionCriterion** — id / scope / criterion / weight.
   - **Workspace** — task / goal_stack / active_scope / current_state /
     relevant_memory / active_constraints / candidate_actions /
     uncertainty / decision_criteria. 매 요청마다 전체 DB 안 읽고
     작은 작업공간을 구성. Global Workspace Theory 근거.

   schema 형태(별 table / view / projection)는 P0.5 schema PR에서
   별 ADR / DEC로 결정. 본 ADR은 객체 모델만 commit.

5. **`procedure` kind를 skill library로 강화.** ADR-0009 enum의
   `procedure`를 first-class skill library로 다룬다(Voyager 패턴).
   reusable judgment-action procedure(예: "사용자가 압도되면 결정
   공간을 먼저 압축한 뒤 구현 디테일을 제안" / "MVP scope 결정 시
   PRD non-goal 먼저 확인")를 procedure row로 명시 보존. 본격 library
   기능 / API는 P1 도입. P0.5는 enum에만 포함.

6. **Phase 재구성.** ADR-0009 §Phase 0-5 roadmap의 Phase 1(P0.5)
   범위를 다음으로 확장한다.
   - **P0.5**: Event Memory + Judgment Ledger + Goal 최소형 +
     Workspace 최소형 + Reflection 최소형 + Eval 질문 세트(=
     ADR-0009 Phase 1) + JudgmentItem 신규 optional 필드.
   - **P1**: Attention scoring formula + Procedure library + Active
     experiment loop + Consolidation loop + (ADR-0009 Phase 2 typed
     tool과 병합).
   - **P2+**: Vector / graph projection + 더 robust한 metacognition +
     multi-step planning + self-evaluation(= ADR-0009 Phase 3-5).

7. **ADR-0009 supersede 아님 — 확장.** ADR-0009의 commitment 7개,
   `JudgmentItem` schema, typed tool 8개, 12 Laws 모두 유효. 본 ADR은
   그 위에 cognitive layer / schema 확장 / 신규 first-class 객체 /
   Phase 재구성을 추가할 뿐이다. ADR-0006 / ADR-0008과의 정합도
   유지(`memory_items`와 `judgment_items` 분리는 그대로 — Q-027 결정
   Phase 1로 이월).

## Alternatives considered

- **Cognitive layer를 별도 product layer / 외부 service로 분리.**
  단일 사용자 actwyn에는 운영 surface가 과도. 통합 spec이 더 단순.
- **6개 보강을 한 번에 다 P0.5에 도입.** Scope creep. P0.5는 Goal /
  Workspace / Reflection 최소형 + Eval만, Attention / Procedure
  library / Active experiment / Forgetting policy는 P1로 분할.
- **ADR-0009 그대로 유지하고 `docs/JUDGMENT_SYSTEM.md`만 보강.**
  Architectural framing 확장(memory store → cognitive architecture)은
  promotion rule 3가지 모두에 해당 — ADR가치가 있음.
- **12-layer를 그대로 12 column / 12 schema 객체로 codify.**
  Over-engineering. optional 필드 + Phase별 도입으로 시작.
- **신규 객체 3개를 Workspace 하나로 통합.** Goal과 DecisionCriterion은
  Workspace 외부에서도 reuse(다른 task의 workspace 구성, eval 자동
  생성)되므로 분리가 더 자연스럽다.

## Consequences

- [`docs/JUDGMENT_SYSTEM.md`](../JUDGMENT_SYSTEM.md)에 §Cognitive
  Architecture Extension 신설 — sub-section 14개(Why extend / Cognitive
  loop / 12-layer / JudgmentItem schema extension / Goal model /
  DecisionCriterion model / Workspace model / Attention scoring /
  Metacognition fields / Skill library / Forgetting policy / Phase 재구성
  / Comparison / Disclaimers).
- ADR-0009 §Phase 0-5 roadmap의 Phase 1(P0.5) sub-section은 본 섹션과
  cross-ref로 갱신("see §Cognitive Architecture Extension for P0.5
  cognitive scope").
- Phase 1 schema PR(별 ADR 후보)에서 결정해야 할 항목.
  - `JudgmentItem`에 신규 optional column 추가 형태(stakes / risk /
    valence / user_emphasis / confidence_reason / missing_evidence /
    would_change_if / review_trigger / uncertainty_notes).
  - 신규 table(`goals` / `decision_criteria` / `workspaces`?) 도입
    여부 / view / projection 형태.
  - Procedure library 운영 형태(`kind: 'procedure'` 단일 enum vs 별
    table vs LLM system prompt block — Q-033 trigger).
- Attention scoring formula는 P1 implementation. P0.5는 ADR-0009
  §Read path의 retrieval 우선순위 / scope filter / FTS5만으로 충분.
- Forgetting / decay / consolidation policy(delete / expire /
  supersede / archive / compress 5종)는 ADR-0009 supersede / DEC-006
  (`/forget`)와 정합. P0.5는 supersede + revoke만, 나머지는 P1.
- 신규 DEC 2개(DEC-024 / DEC-025) + 신규 Q 4개(Q-032 ~ Q-035) 추가.
- ADR-0006 / ADR-0008 정합 유지. `memory_items` ↔ `judgment_items`
  분리는 Q-027 결정 그대로 이월.
- 사용자 framing("개인 AI의 판단 기관")이 정합 spec으로 명시화 — 향후
  product communication / docs / onboarding 일관성 확보.

## Risks and mitigations

| Risk | Mitigation |
| ---- | ---------- |
| 12-layer가 over-engineering — 단일 사용자 P0.5에 과한 surface | P0.5는 6 layer만(Event / Episodic / Semantic / Judgment / Goal 최소형 / Workspace 최소형). 나머지는 P1+로 명시 분리. |
| `JudgmentItem` 필드 비대 — schema bloat | 신규 필드 모두 optional + default value + gradual adoption. P0.5 schema PR에서 enum value만 지정, 강제는 P1+. |
| Cognitive analogy가 marketing / communication에서 misleading | 본 ADR Context에 _engineering approximation, not biological replica_ 명시. `docs/JUDGMENT_SYSTEM.md` §Disclaimers에서 consciousness / emotion / intuition 복제가 목표 아님을 별도로 codify. |
| 사용자가 P0.5 / P1 우선순위를 다시 흔들 가능성 | review trigger에 사용자 직접 사용 패턴 변화(특히 Goal / Workspace 활용 빈도) 포함. eval harness가 Phase별 우선순위 재조정에 evidence 제공. |
| Procedure library 도입 형태 불확정(Q-033) | P0.5는 enum 보존만. 본격 library는 P1에서 별 ADR / DEC로 결정. |
| Goal / Workspace / Reflection 최소형의 "최소" 정의 모호 | Phase 1 schema PR에서 명시. 본 ADR Decision 4 / Consequences에 모델만 commit, 운영 형태는 후속 결정. |

## Review trigger

다음 중 하나가 발생하면 본 ADR을 재검토한다.

- Goal / Workspace / Reflection 최소형 P0.5 구현 시(별 ADR 후보).
- Attention scoring formula 구현 시(Phase 1 — 정적 vs 학습 기반 결정,
  Q-034 trigger).
- Procedure library 본격 도입 시(Phase 1 — `kind: 'procedure'` 단일
  enum vs 별 schema vs system prompt block, Q-033 trigger).
- 사용자가 cognitive analogy framing을 바꾸자고 할 때(Q-035 — psychology
  terminology vs engineering terminology).
- 외부 cognitive architecture(CoALA / ACT-R / Soar / Letta core memory
  blocks / Mem0 / MemGPT) 도입 검토 시 — 본 spec이 기존 service에
  매핑되는지 비교.
- `JudgmentItem` 신규 optional 필드 강제(required) 승격 시 — 별 ADR /
  DEC.
- Memory poisoning 또는 misaligned reflection / consolidation incident
  발생 시 — Security review.

## Refs

- Import source: [second-brain Ideation 노트 Round 9](https://github.com/alxdr3k/second-brain/blob/main/Ideation/second-brain-as-judgment-layer.md)
  (Round 9 + Appendix A.18 ~ A.19).
- 본 결정의 architecture spec: [`docs/JUDGMENT_SYSTEM.md`](../JUDGMENT_SYSTEM.md)
  §Cognitive Architecture Extension.
- ADR-0009 (DB-native, AI-first Judgment System) — **확장**되며 supersede
  되지 않음.
- ADR-0011 (architecture upgradeability + memory activation lifecycle) —
  본 ADR의 §Attention scoring formula는 ADR-0011의 activation_score로
  통합되어 단일 formula가 됨. status enum / 시간 필드 / decay policy
  추가 확장.
- ADR-0012 (Origin/Authority separation + Metacognitive Critique Loop) —
  본 ADR의 Reflection layer를 control-plane triage layer로 정교화.
  `ReflectionTriageEvent` / `DesignTension` / `interaction_signals` /
  `critique_outcomes` 신규 control-plane object. 사용자 비판 패턴 5종을
  시스템화한 Critic Loop 8단계.
- ADR-0013 (Critique Lens v0.1 + Tension Generalization + Status Axis
  Separation) — 본 ADR의 Reflection layer를 5 sub-action으로 분해
  (`reflection_triage` / `reflection_proposal` / `consolidation` /
  `critique` / `eval_generation`). Workspace 객체를 3축 분리
  (`WorkspacePlan` / `ContextPacket` / `WorkspaceTrace`). procedure
  kind에 `procedure_subtype` 5 enum 추가.
- ADR-0003 (SQLite canonical), ADR-0006 (explicit memory promotion),
  ADR-0008 (durable ledgers) — 정합 유지.
- DEC-022 (second-brain repo는 canonical 아님), DEC-023
  (`JudgmentItem.kind` v1 enum 범위), DEC-024 (P0.5 cognitive scope),
  DEC-025 (JudgmentItem metacognitive 필드 도입 정책).
- Q-027 (memory ↔ judgment 관계), Q-028 (kind v1 enum), Q-029 (FTS5 vs
  sqlite-vec), Q-030 (second-brain repo 정책 문서), Q-031 (eval harness
  도입 시점), Q-032 (P0.5 layer 우선순위), Q-033 (procedure library
  운영 형태), Q-034 (attention_score formula), Q-035 (cognitive analogy
  communication).
- 외부 근거:
  - **CoALA** — Cognitive Architectures for Language Agents
    ([arxiv.org/abs/2309.02427](https://arxiv.org/abs/2309.02427)).
    modular memory + structured action + decision process.
  - **Generative Agents** — Park et al.
    ([arxiv.org/abs/2304.03442](https://arxiv.org/abs/2304.03442)).
    reflection / planning loop.
  - **Reflexion** — Shinn et al.
    ([arxiv.org/abs/2303.11366](https://arxiv.org/abs/2303.11366)).
    verbal self-reflection을 lesson으로.
  - **Voyager** — Wang et al.
    ([arxiv.org/abs/2305.16291](https://arxiv.org/abs/2305.16291)).
    skill library 패턴.
  - **MemGPT** — Packer et al.
    ([arxiv.org/abs/2310.08560](https://arxiv.org/abs/2310.08560)).
    core vs archival memory tier.
  - **Letta core memory blocks** — always-visible blocks vs on-demand
    archival search.
  - **Complementary Learning Systems** — McClelland, McNaughton,
    O'Reilly 1995
    ([Stanford](https://stanford.edu/~jlmcc/papers/McCMcNaughtonOReilly95.pdf)).
    fast / slow learning, consolidation, forgetting.
  - **Global Workspace Theory** — Baars, Dehaene
    ([PMC8660103](https://pmc.ncbi.nlm.nih.gov/articles/PMC8660103/)).
    Workspace 모델 근거.
  - **Damasio somatic marker hypothesis**
    ([MRC CBU review](https://www.mrc-cbu.cam.ac.uk/personal/tim.dalgleish/dunnsmhreview.pdf)).
    value / salience layer 근거.
  - **Metacognition review**
    ([PMC3318764](https://pmc.ncbi.nlm.nih.gov/articles/PMC3318764/)).
    confidence / would_change_if 근거.
  - **Free Energy Principle / Active Inference** — Friston et al.
    ([PMC8871280](https://pmc.ncbi.nlm.nih.gov/articles/PMC8871280/)).
    experiment loop 근거.
  - **ACT-R / Soar** — production system + procedural memory의
    classical cognitive architecture.
