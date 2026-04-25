# ADR-0009 — DB-native, AI-first Judgment System

- Status: accepted
- Date: 2026-04-26
- Supersedes: —
- Superseded by: —

## Context

actwyn은 단순 reply bot이 아니라 source-grounded 판단을
누적하고 그 위에서 행동하는 personal agent를 지향한다. 이를 위해
"무엇을 기억하느냐"(memory)와 "지금 무엇을 믿고 어떻게 행동할지"
(judgment)를 모두 다뤄야 한다.

ADR-0006(explicit memory promotion) + DEC-007(supersede via
`memory_items`)이 memory layer의 1차 기둥을 세웠지만, 다음 항목은
아직 명시적으로 결정되지 않은 채로 남아 있다.

- judgment의 **canonical store가 어디인가**.
- judgment write가 **어떤 인터페이스로 이뤄지는가**.
- vector / graph / Markdown / GitHub repo 가운데 어떤 것이 **canonical
  이고 어떤 것이 derived projection인가**.
- 외부 PKM repo (`alxdr3k/second-brain`)는 actwyn judgment system에서
  어떤 역할인가.

이 결정은 second-brain repo에서 7 라운드에 걸쳐 논의되었고
([second-brain Ideation 노트](https://github.com/alxdr3k/second-brain/blob/main/Ideation/second-brain-as-judgment-layer.md)
Round 7 + Appendix A), 사용자가 다음 8가지 조건을 명시적으로
제시했다.

1. actwyn 판단 시스템 설계가 지상과제.
2. Obsidian을 실제로 쓰지 않는다.
3. MVP에서 Obsidian을 쓰지 않을 것이다.
4. GitHub PR write-back 마찰이 너무 크다.
5. 연구들이 vector / graph DB를 쓰는데 그쪽으로 틀어야 하는가?
6. second-brain repo는 사람이 직접 편집하지 않는다 — AI를 통해서만
   조회 / 편집한다.
7. second-brain(개념)을 처음부터 AI-first로 재설계하고 싶다.
8. 지금까지 대화는 second-brain Ideation 노트에 보존되어 있다.

이 조건들 위에서 Markdown vault를 canonical로 유지하는 모든 합의가
전제부터 흔들린다. Phase 0(지금)에 architectural commitment를
명시해 두지 않으면, 다음 phase에서 schema / typed tool 구현이
전제 충돌로 다시 갈리게 된다. ADR-0003(SQLite is canonical) /
ADR-0004(S3 is artifact archive only) / ADR-0006(memory promotion)
/ ADR-0008(durable ledgers)는 이 결정과 정합해야 하며, ADR-0006은
**확장**되되 supersede되지 않는다.

## Decision

actwyn 안에 **DB-native, AI-first Judgment System**을 새로
설계한다. 7개 핵심 commitment.

1. **Canonical store는 actwyn DB.** P0 / P0.5는 SQLite (ADR-0003),
   P2+에서 Postgres + pgvector를 후보로 검토. Markdown / GitHub /
   Obsidian / vector DB / graph DB 어느 것도 canonical이 아니다.
2. **second-brain GitHub repo는 canonical 아니다.** 역할은 (a) seed
   corpus (지금까지 누적된 생각·대화의 import source), (b)
   human-readable export, (c) backup / archive, (d) publishing
   layer. 실시간 memory write path도, agent runtime retrieval primary
   DB도 아니다.
3. **Judgment layer는 ADR-0006의 memory layer 위에 추가된다.**
   ADR-0006을 supersede하지 않는다. `memory_items` 테이블은 그대로
   유지하고, judgment layer는 별도 schema (`judgment_items`,
   `judgment_sources`, `judgment_evidence_links`, `judgment_edges`,
   `judgment_events`)로 추가한다 (`docs/JUDGMENT_SYSTEM.md` §SQL
   schema sketch). PRD §12.1a taxonomy(transcript / summary / memory
   / artifact / storage_object / memory_artifact_link)도 그대로
   유지하며, judgment는 그 위 layer.
4. **AI는 typed tool로만 judgment를 변경한다.** 자유 Markdown edit이
   아니라 `judgment.propose` / `judgment.commit` / `judgment.supersede`
   / `judgment.revoke` / `judgment.query` / `judgment.explain`
   (+ `link_evidence` / `update_current_state`). proposal과 commit
   분리, `assistant_generated` / `inferred`는 자동 commit 금지.
   ADR-0006의 explicit-save-first 원칙을 judgment layer로 일관 적용.
5. **핵심 객체는 source-grounded, scoped, temporal, supersedable
   `JudgmentItem`이다.** note(파일)가 아니라 row. 모든 active
   judgment는 source / evidence link를 가져야 하며, current truth는
   hand-written 문서가 아니라 active items에서 superseded / revoked
   / expired를 뺀 **materialized projection**이다.
6. **Vector / graph DB는 derived projection.** 도입 시점은 P1+. P0 /
   P0.5는 SQLite + FTS5만으로 충분 (ADR-0003 정합). 본 ADR에서 vector
   / graph 채택은 결정하지 않는다 (review trigger로만 보존).
7. **12 Laws 채택.** Raw input is not memory / Memory is not judgment
   / Judgment requires evidence / Current truth is a projection /
   Everything is scoped / Time is first-class / Supersede do not
   overwrite / Negative knowledge is first-class / Procedures are
   privileged / Retrieval must explain itself / Every write is an
   event / No eval no intelligence. 정의는
   [`docs/JUDGMENT_SYSTEM.md`](../JUDGMENT_SYSTEM.md) §12 Laws.

세부 architecture(6단계 pipeline / data model / enum 카탈로그 /
write·read path / explain API / SQL schema sketch / tool contract /
eval harness / security invariants / module structure / phase 0-5
roadmap)는 [`docs/JUDGMENT_SYSTEM.md`](../JUDGMENT_SYSTEM.md)에서
single source로 관리한다.

## Alternatives considered

- **second-brain GitHub repo를 canonical로 유지.** Markdown vault
  + frontmatter `judgment_role` optional 필드로 judgment를 표현 (Round
  5-6 합의). 사용자 조건 4·6·7과 양립 불가; AI write path가 PR
  workflow를 매번 통과하면 product UX 자체가 잡아먹힌다.
- **Markdown frontmatter `judgment_role` optional 필드 (DB 없이).**
  Schema enforcement 약함, partial update 어려움, current / history
  섞임. AI-first와 정합 안 됨.
- **Vector DB를 canonical로 (Pinecone / Qdrant / sqlite-vec 단독).**
  Semantic / episodic / procedural memory 혼재로 retrieval 오염.
  supersede chain / scope / temporal validity 표현이 어려움. 2026
  Memory Poisoning 연구 + OWASP AI Agent Security cheat sheet 근거.
- **Graph DB를 canonical로 (Neo4j / Graphiti).** Temporal multi-hop
  reasoning에 유리하지만 단순 lookup / FTS / scope filter에서 비싸고
  복잡함. P0 단일 사용자에 과한 ops surface.
- **`memory_items` 테이블을 그대로 확장 (judgment column 추가).**
  ADR-0006의 의미를 흐리고, source-grounded judgment 모델의 차원
  (scope / evidence / supersede chain / projection)을 한 테이블에
  밀어넣게 됨. 명시적 layering이 더 단순.

## Consequences

- 새 SQLite schema 5 tables 추가 예정 (Phase 1, 별 ADR / 별 PR):
  `judgment_sources`, `judgment_items`, `judgment_evidence_links`,
  `judgment_edges`, `judgment_events`. ADR-0003(SQLite canonical)와
  정합.
- 새 typed tool 8개 (Phase 2). ADR-0006의 explicit-save-first가
  proposal / commit 분리로 자연스럽게 확장됨.
- ADR-0006의 `memory_items` table은 그대로 유지. judgment layer가
  그 위에 layering. PRD §12.1a taxonomy에 `judgment` 항목이 추가될
  여지 (별 PR에서 갱신).
- `src/judgment/...` 모듈 추가 (Phase 1+). 모듈명 `judgment` 채택
  (memory가 아니라 judgment — "저장"이 아니라 "판단" 프레이밍).
- 보안 invariant 강화: retrieved memory / judgment는 system policy
  나 tool permission을 override 못 함. procedure / policy memory는
  `user_confirmed` 또는 system-authored provenance 필수. 이는
  ADR-0006의 promotion gate를 procedure / policy 영역으로 확장.
- second-brain GitHub repo의 후속 처분은 본 PR scope 밖. 별도
  결정 필요 (Q-027 참조).
- Eval harness 새로 구축 (Phase 2+). RAGAS metrics + actwyn 추가
  metric (current_truth_accuracy, supersede_respect_rate,
  source_grounding_rate, negative_knowledge_recall,
  memory_poisoning_rejection_rate, decision_explainability).

## Risks and mitigations

| Risk | Mitigation |
| ---- | ---------- |
| `memory_items`(ADR-0006)와 `judgment_items` 사이 의미 중복 / 사용자 혼란 | Phase 1 schema PR에서 두 테이블의 책임 boundary를 PRD §12.1a taxonomy로 확장하여 codify. Q-027(memory ↔ judgment 통합 vs 분리)을 결정 트리거로 trace. |
| Enum rigidity (kind 10 / status 6 등) — 초기 schema가 너무 풍부 | Phase 1 도입 enum 범위는 본 ADR이 아니라 후속 ADR / DEC에서 결정 (Q-028 참조). 5-6개 핵심 kind부터 시작 후보. |
| Typed tool latency가 hot path에 영향 | proposal / commit 분리는 hot path에 commit만 — propose는 background ledger 작업. ADR-0008의 ledger 패턴과 정합 (write-before-ack). |
| Memory poisoning (OWASP AI Agent Security) | 보안 invariant + procedure / policy memory의 엄격한 provenance gate (`docs/JUDGMENT_SYSTEM.md` §Security invariants). retrieved memory의 system / tool permission override 차단. |
| second-brain repo deprecate 후속 미정 | Phase 0 PR scope 밖으로 명시. Q-030으로 분리 trace. seed corpus / export role은 즉시 유효, 정책 문서 처분은 별도 PR. |

## Review trigger

다음 중 하나가 발생하면 본 ADR을 재검토한다.

- Phase 1 schema 구현 시 `memory_items` ↔ `judgment_items` 통합
  결정이 필요할 때 (Q-027).
- Vector DB 도입이 실제 필요할 때 (FTS5 / metadata retrieval로
  부족하다는 evidence가 누적될 때 — Phase 4 trigger).
- Graph DB 도입이 실제 필요할 때 (temporal multi-hop reasoning이
  실제 병목일 때 — Phase 5 trigger).
- 사용자가 외부 PKM (Obsidian / Logseq / 별도 repo)을 다시 도입할
  때 — Round 7 사용자 조건 2-3-6-7이 흔들리면 canonical store
  결정 자체를 재검토.
- Memory poisoning incident가 실제로 발생했을 때 — Security review.

## Refs

- Import source: [second-brain Ideation 노트](https://github.com/alxdr3k/second-brain/blob/main/Ideation/second-brain-as-judgment-layer.md)
  (Round 7 + Appendix A.1 ~ A.17).
- 본 결정의 architecture spec: [`docs/JUDGMENT_SYSTEM.md`](../JUDGMENT_SYSTEM.md).
- PRD §12 (Memory and Storage Requirements), 특히 §12.1a Taxonomy /
  §12.2 Provenance / §12.2a Corrections and Supersedence.
- HLD §6.5 (`memory_items.status` state machine).
- ADR-0003 (SQLite is canonical), ADR-0004 (S3 archive only),
  ADR-0006 (explicit memory promotion), ADR-0008 (durable ledgers).
- DEC-006 (`/forget` 명령 set), DEC-007 (correction via supersede),
  DEC-022 (second-brain repo는 canonical 아님), DEC-023 (`JudgmentItem.kind`
  v1 enum 범위).
- Q-027 (memory ↔ judgment 관계), Q-028 (kind v1 enum 범위), Q-029
  (FTS5 vs sqlite-vec leave-room), Q-030 (second-brain repo 정책 문서
  처분).
- 외부 근거 (`docs/JUDGMENT_SYSTEM.md` Refs 참조): CoALA, Reflexion,
  Voyager, GraphRAG, Graphiti, Letta, OWASP AI Agent Security
  Cheat Sheet, 2026 Memory Poisoning 연구.
