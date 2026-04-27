# ADR-0014 — Bun runtime stack confirmation: cautions, principles, roadmap

- Status: accepted
- Date: 2026-04-27
- Refines: ADR-0001 (Use Bun + TypeScript for P0)
- Related: ADR-0003 (SQLite WAL), ADR-0004 (S3 archive),
  ADR-0009 (DB-native Judgment System), ADR-0010 ~ ADR-0013
  (Judgment / Critique / Memory activation 계열)
- Source: 2026-04-27 외부 stack review (ChatGPT 분석) — 본 ADR은 그
  결론을 actwyn ADR 형식으로 박제한 것이며, 핵심은 “Bun을 유지하되
  application architecture 의 중심이 아니라 platform adapter 로
  제한한다” 라는 한 문장.

## Context

ADR-0001 에서 P0 runtime 으로 Bun + TypeScript 를 채택했고, 이후
ADR-0009 가 Judgment System 의 canonical store 를 actwyn DB (SQLite)
로 못박았다. P0/P0.5 가 진행되며 다음 질문이 다시 올라왔다:

> Bun 을 계속 써도 되는가? Node/Go/Rust 로 갈아타야 하는가?
> 고성능 요구가 들어오면 Bun 이 병목인가?

외부 review 의 결론은 명확하다 — **현재 actwyn 의 병목과 리스크는
런타임 언어가 아니라** DB schema/query, provider subprocess,
context compiler, queue serialization, observability/eval 쪽에 있다.
즉 “Bun 이라서 충분하다” 가 아니라 **이 workload 가 런타임-CPU
bound 가 아니라 I/O · provider · schema bound 이기 때문에** Bun 이
적합하다.

본 ADR 은 이 판단을 **조심할 부분 / 원칙 / 로드맵** 형태로 codify
하여, P1 (Judgment System 본구현) 진입 전에 stack 논의가 다시
열리지 않도록 고정한다.

## Decision

1. **Bun + TypeScript 를 P0/P1 orchestration runtime 으로 유지한다.**
   ADR-0001 의 결정을 명시적으로 재확인한다.
2. **Bun-native primitive (`bun:sqlite`, `Bun.spawn`, `Bun.S3Client`)
   는 platform adapter boundary 안에만 둔다.** Domain / judgment /
   context / memory 계층에서는 `Bun` global 을 직접 import 하지
   않는다.
3. **고성능 요구는 런타임 교체가 아니라 schema / projection / queue
   분리 / benchmark 로 먼저 해결한다.** Postgres, vector sidecar,
   Go/Rust sidecar 는 측정된 병목 이후의 옵션이다.
4. **Bun upgrade 는 feature upgrade 가 아니라 infrastructure change
   로 취급한다.** 정해진 spike re-run gate 를 통과해야 한다.

이 ADR 은 ADR-0001 을 supersede 하지 않는다. ADR-0001 의 “P0 에서
Bun 채택” 결정을 그대로 두고, **P1 이후 Judgment System 까지
Bun 을 계속 쓰겠다는 후속 확언 + 운영 원칙 + 트리거** 를 추가한다.

## 조심할 부분 (Cautions)

> 이 ADR 의 목적은 “Bun 이 충분하다” 라고 안심시키는 것이 아니라,
> Bun 을 계속 쓰는 동안 **무엇이 실제 위험한가** 를 명시하는 것이다.

### C1 — Bun-native API lock-in 은 실제 리스크다

핵심 경로는 `bun:sqlite`, `Bun.spawn`, `Bun.S3Client`, Bun test
runner, Bun 의 직접 TS 실행에 강하게 의존한다 (ADR-0001 §Decision).
Bun 1.3 계열은 Node 호환성을 계속 개선 중이지만 공식 문서도
“closer to 100% Node.js API compatibility” 라고 표현한다 — **drop-in
replacement 로 전제하면 안 된다.**

대응은 “전면 이주” 가 아니라 **Bun 의존을 platform adapter 안에 가두는
것** 이다. 이미 [`src/db.ts`](src/db.ts),
[`src/providers/subprocess.ts`](src/providers/subprocess.ts),
[`src/storage/s3.ts`](src/storage/s3.ts) 가 그 역할을 하고 있다 —
이 boundary 를 더 엄격히 한다 (§ Principle P1 참조).

### C2 — “고성능” 의 병목은 Bun 이 아니라 worker / DB 구조다

현재 worker 는 polling 으로 job 을 claim 하고 idle 시 ~200ms sleep
하며, context build / memory query / command handling / provider
dispatch / storage sync / notification retry 를 모두 한 loop 가
관장한다. P0 에서는 단순해서 좋지만 Judgment System 이 들어오면
context compiler · current operating view · evidence selection ·
FTS/vector projection · critique loop 가 추가된다.

이 때 병목은 “Bun 이 느림” 이 아니라 다음 중 하나일 가능성이 압도적
으로 크다:

1. `judgment_items` / evidence / edges / events 의 **index 설계**
2. context compiler 가 매 요청마다 **너무 많은 row 를 읽는** 문제
3. provider job 과 background reflection / eval 이 **같은 worker
   loop 를 공유** 하는 문제
4. SQLite single-writer 구조에서 **write-heavy telemetry 가 hot path
   와 충돌** 하는 문제

→ “고성능” 이라는 단어가 들리면 먼저 schema · projection · queue
분리 · benchmark 를 봐야 한다. 런타임 교체는 그 다음이다.

### C3 — synchronous SQLite 는 discipline 이 필요하다

`bun:sqlite` API 는 synchronous 다. 현재처럼 짧은 transaction · 작은
query 에서는 적합하지만, Judgment System 에서 **대량 projection
rebuild · FTS rebuild · eval aggregation · vector candidate
generation** 을 같은 process / event loop 에서 오래 돌리면 Telegram
poller 와 worker responsiveness 가 떨어진다.

대응:

- write transaction 은 계속 짧게 유지 (`BEGIN IMMEDIATE` 패턴)
- projection rebuild 는 별도 job 으로 chunk 분할
- CPU-heavy embedding / vector 작업은 별도 process 또는 sidecar
- `current_operating_view` 는 read-time full recompute 가 아니라
  materialized projection 우선
- SQLite query benchmark 를 CI 또는 pre-PR script 에 포함

### C4 — lint / format / eval harness 가 약하다

현재 [`docs/TESTING.md`](docs/TESTING.md) 기준 자동화는 `bun test`,
`tsc --noEmit`, single-redactor lint 정도다. P0 에서는 충분하지만
Judgment System 은 도메인 모델 · schema · typed tool · projection ·
eval 까지 커진다. **이 복잡도를 수동 formatting + typecheck 만으로
버티는 것은 장기적으로 무리다.**

해법은 “Bun 을 버리자” 가 아니라 다음 보강이다:

- Biome 또는 ESLint + formatter 도입 (dependency 최소주의를
  유지하려면 Biome 한 개로 시작)
- SQL migration lint / check 추가
- context compiler golden test
- judgment proposal / commit policy property test
- prompt / context packing snapshot test
- perf benchmark script

### C5 — Bun upgrade 자체가 미니 incident 가 될 수 있다

ADR-0001 risk 표에서 SP-01 / SP-07 / SP-08 을 patch upgrade 시 재실행
하도록 정해두었다. 본 ADR 은 이를 **PR-level checklist 로 강제** 한다
(§ Principle P3 참조).

## 원칙 (Principles)

> 이 4가지 원칙은 P1 / Judgment System 코드를 작성할 때 **PR 리뷰
> 시점에 적용 가능한 형태** 로 적었다.

### P1 — Bun import 는 platform boundary 에만 둔다

Bun-native import 가 허용되는 위치를 명시적으로 화이트리스트한다:

- [`src/db.ts`](src/db.ts) — `bun:sqlite`
- [`src/providers/subprocess.ts`](src/providers/subprocess.ts) —
  `Bun.spawn`
- [`src/storage/s3.ts`](src/storage/s3.ts) — `Bun.S3Client`
- entrypoint / config / test bootstrap (제한적)

**그 외 모든 domain · judgment · context compiler · memory · queue
정책 · critique 코드에서는 `Bun` global 또는 `bun:*` import 를 직접
쓰지 않는다.** 새 코드가 위반하면 review 에서 reject 한다. 이
원칙이 무너지면 나중에 일부 data-plane 만 Node/Go/Postgres 로
옮기려 할 때 blast radius 가 폭발한다.

### P2 — “고성능” 은 schema → projection → queue 분리 → benchmark
순서로 푼다. 런타임 교체는 그 뒤다

ADR-0009 의 “canonical store = SQLite, vector/graph 는 derived
projection” 노선을 그대로 따라간다. 성능 최적화 우선순위:

1. SQLite schema / index / projection 정리
2. FTS5 도입
3. query plan 확인 (`EXPLAIN QUERY PLAN`)
4. `current_operating_view` materialization
5. 그래도 부족할 때 vector sidecar / sqlite-vec / pgvector 검토
6. 그래도 부족하면 Postgres 또는 dedicated retrieval service
7. 그 후에야 runtime 변경 (Node/Go/Rust sidecar) 를 고려

“이 부분이 느릴 것 같다” 는 직관에 기반한 런타임 교체 PR 은 reject
한다. **measured baseline 없이는 stack 변경하지 않는다.**

### P3 — Bun upgrade 는 infrastructure change 로 취급한다

`.bun-version`, `package.json#engines`, `config/runtime.json#required_bun_version`
은 항상 동일 patch 로 잠근다. Bun bump PR 은 다음 checklist 를 통과
해야 merge 한다:

```text
Bun bump PR checklist
- bun test
- tsc --noEmit (typecheck)
- SQLite WAL / BEGIN IMMEDIATE contention test
- subprocess spawn / cancel / PGID teardown test
- S3 put / get / stat / list / delete smoke test
- systemd restart / recovery smoke test
- memory / context golden tests
```

각 항목은 ADR-0001 의 SP-01 / SP-07 / SP-08 에 대응한다. **“Bun
공홈에 새 patch 가 떴으니 올리자” 는 PR 은 description 만으로
승인되지 않는다.**

### P4 — Performance budget 을 코드화한다

Judgment System 이 들어오면 “감” 으로는 못 잡는다. 다음 budget 을
초기값으로 둔다 (host 별 재보정 가능):

| Path                            | 목표                           |
| ------------------------------- | ---------------------------- |
| job claim transaction           | p95 < 10ms                   |
| context compiler DB read        | p95 < 50ms, hard cap < 150ms |
| context packing / render        | p95 < 50ms                   |
| Telegram inbound transaction    | p95 < 20ms                   |
| summary / judgment proposal write | hot path 밖에서 수행          |
| projection rebuild              | chunked background job       |

이 표는 “Bun vs Node” 논쟁을 자르기 위한 장치다 — 측정 없이 “느릴
것 같다” 로 stack 을 흔들지 않는다.

## 로드맵 (Roadmap)

### 지금 (P0 마감 ~ Judgment 진입 직전)

Bun + TypeScript + SQLite WAL + systemd 를 그대로 둔다. Judgment
System 구현 전에 다음 작은 PR 을 추가한다 (모두 본 ADR 이 근거):

1. **`docs: runtime stack risk register`**
   Bun-native primitive 별 risk · fallback · test gate 를 한 곳에
   정리. 본 ADR 의 §C1~C5 를 표로 옮긴다.
2. **`test(runtime): bun primitive smoke suite`**
   SQLite WAL claim, spawn teardown, S3 transport contract 를 작은
   smoke / integration test 로 고정. P3 checklist 의 자동화.
3. **`refactor(platform): isolate Bun-native imports`**
   현재 boundary 가 거의 지켜지고 있지만, 새 judgment / context
   코드에서는 Bun global 금지를 lint 또는 review checklist 로 명문화.
4. **`chore(tooling): add formatter/lint`**
   Biome 한 개로 시작. dependency 최소주의를 유지하려면 “format /
   lint 만” 으로 범위를 잠근다.
5. **`perf(context): add compiler/query benchmark harness`**
   Judgment 진입 전 baseline 확보. P4 budget 의 측정 도구.

### P1 / Judgment System 구현 중

- SQLite + FTS5 우선
- `current_operating_view` 를 **materialized projection** 으로 설계
  (read-time full recompute 금지)
- control-plane telemetry 는 hot path 와 분리된 table / job 으로
- provider job 과 reflection / eval / critique job 의 scheduling
  priority 분리
- write-heavy event table 에 대한 index / retention 정책을 schema
  단계에서 선결정

### P2 이후 (조건부)

다음 중 하나가 **실측** 으로 확인되면 sidecar / 외부 DB 를 검토한다.
실측 없이는 진입하지 않는다.

- SQLite DB 파일 / 인덱스가 커져 context compiler latency budget
  (P4) 을 못 맞춤
- multi-device / multi-user 동시성이 필요해짐
- vector search 가 core UX 가 됨
- graph temporal reasoning 이 실제 병목
- long-running projection job 이 Telegram responsiveness 를 해침

이 때 후보:

- SQLite → Postgres 또는 SQLite + sqlite-vec / pgvector
- projection / embedding / graph traversal 을 Go/Rust sidecar 로
- storage 는 그대로 S3-compatible 유지

## Alternatives considered

### Node.js
가장 보수적이고 ecosystem 이 두텁다. 그러나 actwyn 은 의도적으로
Bun-native primitive 를 써서 dependency surface 를 줄였고, Node 로
가면 `bun:sqlite` → `better-sqlite3` / `node:sqlite`, `Bun.S3Client`
→ AWS SDK, `Bun.spawn` wrapper 재검증, `bun test` → Node test runner
/ Vitest, TS 직접 실행 / 빌드 파이프라인 재구성, package manager /
lockfile / CI 교체가 줄줄이 따라온다. 그 대가가 “더 익숙한
ecosystem” 뿐이고 **현재 병목을 직접 제거하지 않는다.** Bun 이
실제 장애를 만들기 전까지는 불필요한 rewrite — reject.

### Go
장기 daemon · subprocess supervision · static binary · low memory 에
훌륭하지만, 이미 TS 로 도메인 모델 / Claude stream-json parser /
Telegram adapter / memory · context logic 이 쌓여 있다. 전면 Go
전환은 성능 개선이 아니라 **제품 구현 속도를 크게 늦추는 rewrite**
다. Go 가 적절해지는 시점은 전면 전환이 아니라 **무거운 sidecar**
(projection rebuild, embedding pipeline, graph traversal) 다 — 본
ADR §Roadmap P2 와 정합.

### Rust
성능 / 안전성은 최고지만 cognitive load 와 개발 속도 비용이 크다.
1인 운영 단계에서는 Judgment System 의 모델링 · 제품 검증이 더
중요하다. SQLite extension, tokenizer, embedding / vector index 같이
**고정된 data-plane component** 에만 한정 검토.

### Python
LLM/RAG 생태계는 좋지만 actwyn 의 runtime hot path (long-running
daemon · subprocess + Telegram + SQLite consistency) 에는 덜 적합하고
지금보다 단순해지지 않는다. Eval harness · offline analysis tool
영역에는 부분 채택 가능.

### 결론
지금 Node / Go / Rust / Python 전면 전환은 모두 **현재 병목을 직접
제거하지 않는 rewrite** 라서 비용 대비 이득이 없다. ADR-0001 의
Bun 결정을 유지하고, 본 ADR 의 원칙 / 로드맵으로 운영 규율을 강화
하는 쪽이 옳다.

## Consequences

- ADR-0001 의 Bun 채택이 P0 한정이 아니라 **P1 / Judgment System
  까지 명시적으로 연장** 된다.
- Bun-native import 는 platform adapter 로만 제한되며, 위반 PR 은
  reject 대상이 된다 (P1).
- 성능 최적화는 schema / projection / queue 순서를 따라야 하며,
  런타임 교체 PR 은 measured baseline 이 없으면 reject 된다 (P2).
- Bun upgrade 는 PR-level checklist 를 통과해야 한다 (P3).
- Performance budget (P4) 이 P1 진입 전 baseline 으로 측정되어야
  한다 — `perf(context): add compiler/query benchmark harness` PR 이
  Judgment System 본구현보다 먼저 머지된다.
- Biome / formatter / lint 보강 PR 이 dependency 정책 (P0 PRD §9.4)
  의 예외로 사전 승인된다 — 단 “format / lint 만” 범위로 잠근다.

## Risks and mitigations

| Risk                                                              | Mitigation                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 새 judgment/context 코드가 무심코 `bun:*` 또는 `Bun.*` 를 import 함 | P1 원칙을 lint rule 또는 PR review checklist 로 강제. 위반 PR reject.                       |
| Bun patch upgrade 가 SP-01/07/08 항목 중 하나에서 regression      | P3 checklist 미통과 시 merge 차단. 기존 patch 로 rollback 후 spike 재실행.                  |
| Judgment 진입 후 “느림” 을 이유로 런타임 교체 PR 이 올라옴        | P2 + P4 — measured baseline + budget 위반 증거 없으면 reject.                               |
| synchronous SQLite 가 hot path 를 막음                            | C3 mitigation 적용 — projection rebuild 분리, 짧은 write tx, embedding/vector 는 별도 worker. |
| Bun.S3Client 가 Hetzner 와 incompat                                | ADR-0001 의 AWS SDK fallback (DEC-010) + `S3Transport` interface 유지.                      |
| Bun.spawn detached 의미가 커널/버전 변화로 깨짐                    | systemd `KillMode=control-group` 의존 강화 + SP-07 재실행.                                  |

## Review trigger

다음 중 하나가 **실측** 으로 발생하면 본 ADR 을 다시 연다:

- Bun SQLite WAL / locking 의 reproducible regression
- `Bun.spawn` cancellation / detached PGID 의 reproducible bug
- `Bun.S3Client` 가 Hetzner 와 호환되지 않게 됨
- multi-user / multi-host 운영 요구
- reflection / eval / projection 이 CPU-bound 로 확정되어 background
  chunking 으로도 budget (P4) 을 못 맞춤
- Node ecosystem 의 필수 module 이 Bun 과 호환되지 않아 sidecar 도
  불가
- ADR-0009 의 SQLite-first 노선이 multi-writer / external retrieval
  요구로 더 이상 유지 불가

이 트리거가 없으면 “Bun 을 바꾸자” 는 논의는 다시 열지 않는다.

## Refs

- [ADR-0001](0001-use-bun-typescript.md) — P0 에서의 Bun 채택 (본 ADR
  이 그 결정을 P1 까지 확장)
- [ADR-0003](0003-sqlite-active-state.md) — SQLite WAL canonical state
- [ADR-0004](0004-s3-as-artifact-archive.md) — S3 archive boundary
- [ADR-0009](0009-db-native-judgment-system.md) — DB-first Judgment
  System (본 ADR §Principle P2 의 근거)
- [`docs/RUNTIME.md`](../RUNTIME.md) — worker loop / dispatch 구조
- [`docs/TESTING.md`](../TESTING.md) — 현재 자동화 (C4 의 근거)
- [`src/db.ts`](../../src/db.ts),
  [`src/providers/subprocess.ts`](../../src/providers/subprocess.ts),
  [`src/storage/s3.ts`](../../src/storage/s3.ts) — Bun-native primitive
  의 platform adapter (P1 boundary)
- 외부 분석: 2026-04-27 stack review (ChatGPT) — 본 ADR 의 §Cautions /
  §Principles / §Roadmap 은 그 분석을 actwyn 운영 규율로 codify 한
  것이며, 결론 한 줄: *“Bun 은 OK. 다만 ‘Bun 이라서 빠르다’ 에
  기대지 말고, Bun 을 얇은 orchestration layer 로 유지하면서
  DB-native Judgment data plane 을 제대로 설계하라.”*
