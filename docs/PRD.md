# Personal Agent — Product Requirements Document

## 1. Executive Summary

Personal Agent는 단일 사용자를 위한 Telegram 기반 개인 AI 런타임이다. 사용자는 Telegram DM으로 자연어 요청을 보내고, 시스템은 AI 프로바이더 CLI를 서브프로세스로 실행하여 비동기로 결과를 반환한다. MVP는 Hetzner CX22 서버에서 Claude Code 단일 수직 슬라이스로 구성된다.

MVP는 디지털 트윈 자체가 아니다. 사용자가 매일 에이전트와 인터랙션하고, 그 데이터를 나중에 디지털 트윈을 만드는 데 사용할 수 있는 가장 작은 신뢰할 수 있는 런타임이다.

---

## 2. Problem Statement

개인 AI 사용은 여러 프로바이더, 여러 세션, 여러 파일, 여러 메모리 저장소에 흩어져 있다. 사용자는 매번 자신의 정보, 프로젝트 맥락, 이전 결정사항을 반복해서 설명한다.

MVP는 두 가지 문제를 해결한다:

1. **반복 설명 비용 감소**: 세션 메모리와 컨텍스트 주입으로 매 요청마다 처음부터 설명하는 비용을 낮춘다.
2. **데이터 원장 구축**: 장기적으로 개인화 에이전트(디지털 트윈)를 만들기 위한 인터랙션 데이터를 체계적으로 쌓는다.

---

## 3. Long-term Vision

최종 목표는 다음을 갖춘 개인 디지털 트윈이다:

- 단기 / 중기 / 장기 메모리 레이어
- 개인 / 프로젝트 / 회사 컨텍스트 레이어
- Obsidian 세컨드 브레인 연동
- 자율 태스크 실행 루프

MVP는 실제 사용 패턴을 관찰한다. 어떤 요청이 반복되는지, 어떤 컨텍스트가 항상 필요한지, 어떤 메모리가 유용한지를 관찰한 데이터가 디지털 트윈의 학습 원천이 된다.

---

## 4. MVP Goals

1. Hetzner CX22에서 단일 사용자 Telegram 봇을 배포하여 Claude Code CLI로 메시지를 라우팅한다.
2. 모든 인터랙션을 redacted raw event와 함께 SQLite에 영속한다.
3. 메모리 파일을 Hetzner Object Storage에 비동기 싱크한다.
4. 재시작 후에도 관측 가능한 상태를 제공하는 job ledger를 구축한다.
5. provenance 추적이 포함된 세션 요약을 생성한다.

**핵심 가설**: Telegram 기반 개인 에이전트 런타임을 실제로 사용하면, 어떤 종류의 요청이 반복되는지, 어떤 context가 매번 필요한지, 어떤 memory가 유용한지 관찰할 수 있다. 이 관찰 데이터가 장기 디지털 트윈의 학습 원천이 된다.

---

## 5. Non-goals

다음은 MVP에서 의도적으로 제외한다.

**P0에서 제외**:

- 멀티유저 프로덕션화
- 그룹 채팅 지원
- Webhook 배포 방식
- Vector DB / 임베딩 검색
- 자율 태스크 실행 루프
- Provider 자동 라우팅
- Obsidian write-back
- 브라우저 / 웹검색 툴 주입
- Gemini / Codex / Ollama 전체 구현 (interface placeholder만)
- 위험한 파일/셸 액션에 대한 Human approval UI
- 여러 provider job 동시 실행
- Langfuse 연동
- 파일 편집, 셸 실행, 배포, 마이그레이션, 파괴적 액션

> "사용자 확인 필요" 케이스는 P0에서 confirmation flow 없이 자동 retry 금지로만 처리한다.  
> 파일 편집, 셸 실행, 배포, 마이그레이션, 파괴적 액션은 Human approval UI가 도입되는 P2 이후에만 허용한다.

---

## 6. Target User

**Primary user**: 단일 개인 사용자. Telegram DM으로 개인 에이전트에게 작업을 요청한다.

서버 운영 및 CLI 도구 사용에 익숙한 기술 사용자를 가정한다. MVP에서 멀티유저 지원은 없으며, 인증된 단일 사용자만 접근할 수 있다.

---

## 7. User Stories

| ID | Story |
|----|-------|
| US-01 | 사용자는 Telegram DM에서 질문/작업 요청을 보내고 비동기로 결과를 받는다 |
| US-02 | 사용자는 `/status`로 현재 queue 상태를 확인한다 |
| US-03 | 사용자는 `/cancel`로 대기 중이거나 실행 중인 작업을 취소한다 |
| US-04 | 사용자는 `/summary`로 현재 세션 요약을 생성한다 |
| US-05 | 사용자는 `/end`로 세션을 종료하고 중기 memory summary를 저장한다 |
| US-06 | 사용자는 `/provider`로 사용할 provider를 전환한다 (P0: claude만 활성) |
| US-07 | 사용자는 `/doctor`로 시스템 상태를 진단한다 |
| US-08 | 사용자는 `/whoami`로 자신의 Telegram user_id와 chat_id를 확인한다 |

---

## 8. Functional Requirements

### 8.1 Telegram 커맨드

| 커맨드 | 설명 |
|--------|------|
| `/new` 또는 `/chat` | 세션 시작 |
| `/end` | 세션 요약 및 종료 |
| `/summary` | 현재 세션 요약 생성 |
| `/status` | queue 상태 확인 |
| `/cancel` | running/queued job 취소 |
| `/provider <name>` | provider 전환 (P0: claude만 활성) |
| `/help` | 사용 가능한 command와 현재 provider/session 표시 |
| `/whoami` | 내 Telegram user_id 표시 |
| `/doctor` | 시스템 상태 진단 (Bun version, Claude auth, SQLite, S3, Telegram push) |

### 8.2 메시지 수신 및 Long Polling

- Telegram Bot API direct fetch 사용. bot framework dependency 없음.
- `getUpdates` 호출 시 `allowed_updates=["message"]` 명시.
- P0에서 `callback_query`, `inline_query`, `channel_post`, `edited_message` 등은 처리하지 않음. 지원하지 않는 update는 `telegram_updates.status=skipped`로 기록.
- 1:1 DM만 허용. 그룹 채팅 대응 안 함.

**Offset 내구성**

- `settings` 테이블에 `telegram_next_offset` 저장.
- authorized message: `jobs` insert + `telegram_updates.status=enqueued` commit 후에만 offset advance.
- skipped update: `telegram_updates.status=skipped` commit 후에만 offset advance.
- batch 수신 시 모든 처리 결과 commit 후 `max(update_id)+1`로 advance.
- crash 후 재시작 시 commit 안 된 update는 다시 처리됨. `update_id`는 idempotency_key로도 사용.

### 8.3 인증 및 접근 제어

- `allowed_user_ids` 설정이 없으면 모든 메시지 무시 (필수).
- unauthorized user 메시지에는 응답하지 않고 job도 생성하지 않음. skipped update로만 기록.
- `/whoami`는 기본적으로 authorized user에게만 응답.

**Bootstrap 모드**: `BOOTSTRAP_WHOAMI=true` 시 `/whoami`만 예외적으로 Telegram `user_id`와 `chat_id`를 반환할 수 있다. 이 상태는 production steady-state에서 비활성화되어야 하며, `/doctor`에서 warning으로 표시한다.

### 8.4 응답 포맷 및 청킹

**응답 포맷 (plain text, parse_mode 없음)**

| 상황 | 메시지 형식 |
|------|------------|
| job accepted | `"접수됨 · <short job_id> · provider · 상태: queued"` |
| job completed | final answer + duration + provider |
| job failed | 사람이 이해할 수 있는 error summary + `/status` 안내 |
| job cancelled | queued 취소인지 running 중단인지 명확히 표시 |

**청킹 규칙**

- chunk size: 3,800 characters (Telegram 한도 이하).
- chunk 순서 보존 필수.
- 각 chunk에 `(1/N)`, `(2/N)` 형식 marker 포함.
- full response는 turns/local transcript에 한 번만 저장. Telegram에는 chunked delivery만 수행.
- chunk 일부 실패 시 `notification_retry` job으로 복구.
- `provider_run succeeded` 상태는 chunk 전송 실패로 되돌리지 않음.

### 8.5 Job Queue 및 Worker

Job queue는 단순 작업 줄이 아니라 상태 원장(job ledger)이다. 재시작 후에도 running job을 failed/recovering 처리하고 Telegram에 상태 전달 가능해야 한다.

**Job 타입**

| 타입 | 설명 |
|------|------|
| `provider_run` | AI provider 호출 |
| `summary_generation` | 세션 요약 생성 |
| `storage_sync` | S3 싱크 |
| `notification_retry` | Telegram 알림 재시도 |

**Job 상태 전이**

```
queued → running → succeeded
                 → failed
                 → cancelled
       → cancelled
       → interrupted  (재시작 시 running이던 job)
```

재시작 복구:
- `status=running`이던 job → `interrupted`로 변경.
- `attempts < max_attempts && safe_retry=true` → `queued`로 복구.
- 그 외 → `failed` + Telegram 장애 알림.

**Post-processing 독립성**: `provider_run` success는 notification 및 storage_sync와 독립이다. S3 sync 실패와 Telegram 알림 실패 모두 `provider_run succeeded` 상태를 되돌리지 않는다.

**Worker concurrency**: P0에서 전역 concurrency 1. 이후 provider별 semaphore + session-level lock으로 확장(same session = serial, different sessions = bounded parallel).

### 8.6 /cancel 동작

- queued job: `status=cancelled`.
- running job: best-effort SIGTERM → grace period → SIGKILL.
- provider side effect가 발생했을 수 있으므로 result는 `cancelled_after_start`로 기록.
- Telegram에 "취소 요청됨 / 완료 / 실패" 상태 알림.

### 8.7 /doctor 진단 항목

| 항목 | 설명 |
|------|------|
| Bun version | exact version 표시, `required_bun_version` 불일치 시 warning |
| Claude auth | CLI 인증 상태 확인 |
| SQLite | 연결 및 schema 상태 확인 |
| S3 smoke test | put / get / stat / list / delete 전체 수행 |
| Telegram push | 간단한 push test |
| `BOOTSTRAP_WHOAMI` | `true` 상태 시 warning 표시 |

S3 smoke test 실패 시 local-only degraded mode로 표시하고 `storage_sync` job은 retryable 상태로 유지한다. P0 acceptance는 S3 smoke test 성공을 요구한다.

---

## 9. Non-functional Requirements

### 9.1 성능

- 단일 서버(Hetzner CX22: 2vCPU, 4GB RAM)에서 단일 사용자 워크로드 처리.
- 기존 서비스(Langfuse + ClickHouse Altinity 3 replica)와 메모리 경합 최소화.
- 경량 우선. 외부 dependency 최소화.

### 9.2 신뢰성

- systemd `Restart=always`, `RestartSec=5`.
- 재시작 후 job ledger 기반 상태 복구.
- Telegram notification: at-least-once delivery. crash/retry 경계에서 중복 전송 가능성은 기록하고 최소화.
- `payload_hash + notification_type + job_id`로 명백한 중복 retry 감소.

### 9.3 리소스 제약

- Ollama는 P1에서 disabled by default. 소형 모델 allowlist만 허용.
- `keep_alive` 짧게 설정 또는 필요 시 unload. 기존 Langfuse + ClickHouse와 메모리 충돌 주의.
- Bun version: exact patch version 고정 (`1.3.x` 같은 range pinning 금지). `required_bun_version`을 `.bun-version` 또는 `config/runtime.json`에 명시. systemd 배포 환경과 local dev 환경의 Bun version 일치 필수.

### 9.4 의존성 정책

P0는 zero/near-zero external dependency를 목표로 한다. 외부 dependency가 필요한 경우 아래를 PRD/구현 계획에 명시한다:

- dependency name
- 목적
- 대체 불가능한 이유
- 예상 memory/runtime impact
- supply-chain risk mitigation

**P0 허용 모듈**:

| 용도 | 모듈 |
|------|------|
| Telegram | direct fetch |
| SQLite | `bun:sqlite` |
| Subprocess | `Bun.spawn` |
| S3 | `Bun.S3Client` |
| HTTP server (optional) | `Bun.serve` (`/healthz` only) |
| Test | `bun test` |
| Validation | handwritten runtime guard |

`bun.lock` commit 필수. 배포는 frozen lockfile 기반. 외부 package 도입 시 `bunfig.toml`에 `minimumReleaseAge` 설정 권장.

---

## 10. Architecture Overview

```
Telegram Channel
      ↓
Auth / Command Parser
      ↓
SQLite Job Ledger + telegram_updates ledger
      ↓
Worker
      ↓
Context Builder + Packer
      ↓
Provider Adapter (Bun.spawn)
      ↓
Result Normalizer
      ↓
Memory Writer (SQLite + local file)
      ↓
Mark provider_run succeeded
      ↓
Create outbound_notifications record
      ↓
Attempt immediate Telegram notification
      ├─ success: outbound_notifications.status=sent, telegram_message_ids_json 저장
      └─ failure: outbound_notifications.status=failed, enqueue notification_retry
      ↓
Enqueue storage_sync (independently)
      ↓
Storage Sync Worker → Hetzner Object Storage (Bun.S3Client)
```

**설계 원칙**:
- `provider_run` success는 notification 및 storage_sync와 독립.
- Job ledger는 상태 원장. 재시작 후에도 observable.
- `notification_retry`와 `storage_sync`는 서로 독립적으로 재시도.

권장 디렉토리 구조는 [Appendix A](#appendix-a-권장-디렉토리-구조)를 참고한다.

---

## 11. Provider Adapter Requirements

### 11.1 공통 인터페이스

모든 provider adapter는 공통 인터페이스(`AgentRequest` → `AgentResponse`)를 따른다. 필드 정의는 [Appendix B](#appendix-b-agentrequest--agentresponse-필드)를 참고한다.

- CLI subprocess adapter (Claude / Gemini / Codex): `Bun.spawn`.
- Local HTTP adapter (Ollama): `fetch`.
- CLI subprocess 호출은 반드시 argv array. **string interpolation 방식 금지**.
- OAuth token extraction 미지원. CLI provider는 사전에 CLI login/auth 완료 필요.

### 11.2 Claude Code (P0, 1순위)

**Command shape**:

```
["claude", "-p", prompt,
 "--output-format", "stream-json",
 ...session_args,
 ...permission_profile_args]
```

**Session args**:

| 상황 | args |
|------|------|
| 첫 요청 | `["--session-id", internal_session_uuid]` |
| 후속 요청 | `["--resume", provider_session_id]` |

- `provider_session_id`가 있으면 후속 resume에 우선 사용.
- resume 실패 시 replay_mode로 fallback. ([Section 12.4](#124-context-packing-모드) 참고)

**Permission profile**:

| 프로파일 | args |
|----------|------|
| Advisory/chat (기본) | `["--permission-mode", "dontAsk", "--tools", ""]` |
| Read-only repo review | `["--permission-mode", "dontAsk", "--tools", "Read,Grep,Glob"]` |

**제약**:
- P0에서 interactive permission prompt를 요구하는 작업 미지원. unattended writable coding agent로 사용 금지.
- `--dangerously-skip-permissions` 기본 금지.
- `--no-session-persistence` 기본값으로 사용 금지.
- `--max-turns`: request별 configurable.
- Prompt delivery: shell string interpolation 금지. P0에서 stdin 기반 전달 미사용 (Claude CLI 검증 후 P1에서 도입 가능).
- `max_prompt_bytes` 또는 안전한 argv 길이 초과 시 provider 실행 전 실패 처리.

**Claude Lockdown Smoke Test (P0 acceptance 조건)**:
- advisory/chat mode: Bash / Edit / Write / Read tool 미실행 검증.
- read-only mode: Read / Grep / Glob만 허용, Edit / Write / Bash 미실행 검증.
- interactive permission prompt 미발생 검증.
- MCP / plugin / settings / hook auto-discovery 개입 여부 확인.
- `--tools ""`가 기대대로 모든 tool을 비활성화하지 못하면 P0 acceptance 실패. 대체 제한 방식(`--disallowedTools`, isolated settings 등) 검토.
- 실제 installed Claude Code version에서 수행해야 함.

> **검증 필요**: `--tools ""`, `--disable-slash-commands`, `--strict-mcp-config` 동작은 installed version에서 직접 확인이 필요하다.

### 11.3 Gemini CLI (P1, 3순위)

P0에서는 interface placeholder만 구현한다. smoke test 통과 후 enabled 상태로 전환.

- `["gemini", "-p", prompt, "--output-format", "stream-json"]`
- resume: `["gemini", "-r", session_id, prompt, "--output-format", "stream-json"]`
- 위험 플래그 기본 금지: `--yolo`, `approval-mode=yolo`.
- smoke test 실패 시 local history accumulation fallback.

> **검증 필요**: slash command, extensions, MCP 동작은 설치 버전별로 검증 필요. resume + output-format 조합 smoke test 필수.

### 11.4 Codex CLI (P2, 4순위)

P0에서는 interface placeholder만 구현한다.

- `["codex", "exec", "--json", prompt]`
- resume: `["codex", "exec", "resume", session_id, "--json", prompt]`
- 위험 플래그 기본 금지: `--dangerously-bypass-approvals-and-sandbox`, `--yolo`.

> **검증 필요**: JSONL 스키마 안정성, OPENAI_API_KEY env var과 OAuth credential 우선순위 충돌 가능성, auth 환경 격리.

### 11.5 Ollama (P1, disabled by default)

P0에서는 interface placeholder만 구현한다.

- `POST http://localhost:11434/api/chat` — `{ model, messages, stream: false }`
- utility provider 취급 (저비용 요약, classification, memory candidate extraction).
- CX22 4GB에서 소형 모델 allowlist만 허용.

### 11.6 P0에서 미지원 provider 요청 처리

`/provider gemini|codex|ollama` 요청은 provider를 전환하지 않고 `not_enabled` 메시지를 반환한다.

### 11.7 알려진 Provider 제약

- CLI 버전 업데이트 시 output format 변경 가능성. 파싱 레이어에 버전 고정 또는 포맷 검증 로직 필요.
- stdout/stderr 혼재, JSONL 파싱 오염 주의.
- same session 동시 요청 시 대화 순서 깨짐. MVP에서 전역 concurrency 1.
- CX22에서 여러 CLI 동시 실행 시 메모리 압박.
- `Bun.spawn`의 `kill()` return value만으로 종료 확인 금지. `proc.exited` + 후속 상태 확인으로 판단.

---

## 12. Memory and Storage Requirements

### 12.1 메모리 레이어

**단기 (SQLite `turns`)**
- user/assistant turn 저장.
- provider별 `session_id` 저장.
- Telegram `chat_id` ↔ internal `session_id` 매핑.

**중기 (SQLite + S3 markdown)**
- `/end` 또는 `/summary` 실행 시, 또는 일정 turn 수 초과 시 `summary_generation` job 생성.
- summary 구분: 사실 / 선호 / 진행 중인 프로젝트 / 미완료 task / 주의사항.
- provenance 및 confidence 포함.

**장기 (로컬 파일 + S3, P0: 저장만 / retrieval은 P2)**

```
memory/personal/YYYY-MM-DD.md
memory/projects/<project_id>/summary.md
memory/sessions/<session_id>.jsonl
```

vector DB 없음. 관찰 데이터 쌓인 후 결정.

### 12.2 Memory Provenance

모든 memory candidate는 provenance를 가진다.

| Provenance | 설명 |
|------------|------|
| `user_stated` | 사용자가 직접 말함 |
| `user_confirmed` | agent가 제안했고 사용자가 확인함 |
| `observed` | 시스템 로그에서 관찰됨 |
| `inferred` | agent가 추론함 |
| `tool_output` | 외부 tool/provider/file에서 온 내용 |
| `assistant_generated` | assistant가 생성한 내용 |

**P0 장기 personal preference 저장 기준**:
- `user_stated` 또는 `user_confirmed`만 신뢰.
- `tool_output`, `assistant_generated`, `inferred`는 장기 personal preference로 승격 금지.
- session summary에는 포함 가능하나 provenance와 confidence를 함께 저장.

### 12.3 Summary Generation

`summary_generation` job은 Claude advisory/chat lockdown profile(`--tools ""`, `--permission-mode dontAsk`)을 사용한다. 파일 편집, 셸 실행, interactive prompt 금지.

**Input**: 선택된 `source_turn_ids` + 현재 session metadata + summary schema instruction.

**Output**: `facts_json`, `preferences_json`, `decisions_json`, `open_tasks_json`, `cautions_json`, `provenance_json`, `confidence_json`.

assistant가 추론한 내용과 사용자가 명시한 내용을 반드시 구분해야 한다. `user_stated` 또는 `user_confirmed` provenance가 없으면 durable personal preference로 승격하지 않는다.

스키마 정의는 [Appendix D](#appendix-d-sqlite-스키마)를 참고한다.

### 12.4 Context Packing 모드

**resume_mode (정상 경로)**
- `provider_session_id`가 유효하고 `--resume`이 성공하는 경우.
- full recent turns replay 금지.
- user message + compact injected context만 전달. delta session summary만 포함.

**replay_mode (fallback 경로)**
- provider session이 깨졌거나 resume 실패 시.
- current session summary + recent N turns 포함.
- replay_mode 사용 여부를 `provider_run`에 기록.

### 12.5 Context Injection (토큰 예산)

| 슬롯 | 예산 | 비고 |
|------|------|------|
| System identity block | 500 tokens | |
| Active project context | 1,000 tokens | |
| Current session summary | 1,000 tokens | |
| Recent N turns | 3,000 tokens | replay_mode에서만 포함 |
| Retrieved long-term memory | 2,000 tokens | P0 비활성 / P2 이후 사용 |
| User message | — | |

provider request 로그에 "무엇을 inject했는지"와 사용한 packing mode를 별도 필드로 저장한다.

### 12.6 Token Estimator

P0는 char 기반 보수적 추정을 사용한다. 정밀 tokenizer dependency는 넣지 않는다. 목적은 context overflow 방지이며, 항상 과소추정보다 과대추정을 선택한다.

| 텍스트 유형 | 추정 방식 |
|------------|-----------|
| ASCII-heavy | `ceil(char_count / 3)` |
| Korean/CJK-heavy | `ceil(char_count / 1.5)` 또는 `ceil(char_count)` 중 더 큰 값 |
| Mixed | 두 추정 중 더 큰 값 |

### 12.7 Storage 구조

**bun:sqlite (WAL 모드)**
- active state 저장: `jobs`, `sessions`, `turns`, `provider_runs`, `memory_summaries` 등.
- transaction은 짧게 유지. provider subprocess 실행 중 DB transaction 열어두지 않음.
- `busy_timeout` 설정.

**로컬 파일**
- redacted provider transcripts.
- conversation transcripts (secret redaction 후 저장).
- memory markdown/jsonl, artifacts, provider parser fixtures.
- P0에서 unredacted provider stdout/stderr raw events 저장 금지.

**Hetzner Object Storage (Bun.S3Client)**
- archive/snapshot/persist layer. active memory DB로 사용하지 않음.
- endpoint: `https://fsn1.your-objectstorage.com`
- `virtualHostedStyle=false` (path-style) 우선. smoke test 실패 시 재검토.
- storage adapter는 driver abstraction 유지 (향후 AWS S3, Cloudflare R2 교체 가능).

**S3 Sync 정책**
- S3 sync 실패는 provider response delivery를 막지 않음. retryable `storage_sync` job으로 분리.
- degraded mode: provider response delivery는 동작, `storage_sync` job은 retryable 상태로 유지.
- Bun.S3Client smoke test 실패 시 P0.5/P1에서 `@aws-sdk/client-s3` fallback 허용 (`@aws-sdk/client-s3`는 P0 기본 dependency 아님).

**SQLite Backup 정책 (Optional)**
- P0에서 S3 sync 기본 대상: memory files, redacted transcripts, artifacts.
- SQLite DB snapshot S3 upload는 optional. 구현 시:
  - WAL mode에서 live db 파일 단순 복사 금지.
  - SQLite backup API, checkpoint 후 copy 등 일관성 있는 backup 절차 사용.
  - `.db`, `.db-wal`, `.db-shm` 파일 처리 정책 명확히 수립.
  - backup 중 provider subprocess 실행 transaction을 열어두지 않음.

---

## 13. Telegram Channel Requirements

### 13.1 Long Polling

- `getUpdates` 기반. Webhook 미사용. TLS/nginx 설정 불필요.
- `allowed_updates=["message"]` 명시.
- direct fetch. bot framework dependency 없음.

### 13.2 Offset 내구성

핵심 불변식: **offset은 항상 SQLite commit 완료 후에만 advance된다.**

- crash 후 재시작 시 commit 안 된 update는 재처리됨.
- 여러 update를 batch로 받으면 모든 처리 결과 commit 후 `max(update_id)+1`로 advance.
- `update_id`는 idempotency_key로 사용하여 동일 update 중복 처리 방지.

### 13.3 Outbound Notification

- Delivery semantics: at-least-once. 중복 전송 가능성은 완전히 제거할 수 없으므로 기록하고 최소화.
- `notification_retry`는 `outbound_notifications.status=failed` 또는 `pending` 상태만 재시도.
- `provider_run succeeded` 상태는 notification 실패로 되돌리지 않음.

스키마 정의는 [Appendix D](#appendix-d-sqlite-스키마)를 참고한다.

### 13.4 Raw Event 저장 정책

- 기본 저장 대상: `provider_raw_events.redacted_payload`.
- redaction은 persistence 전에 수행. 대상: Telegram token, S3 key, provider auth token, API key pattern.
- P0에서 원본 raw 저장 금지.
- provider parser 복구는 `redacted_payload`와 `stderr_redacted` 기준으로 수행.

---

## 14. Observability Requirements

### 14.1 운영 로그 (짧게, 개인정보 최소화)

- latency, provider, exit_code, timeout, retry_count.
- parser_error, token/cost estimate, queue wait time.
- `context_packing_mode` (resume_mode | replay_mode).

### 14.2 디지털 트윈 원천 데이터 (풍부하게, 접근 통제 필수)

- user request, assistant response, session summary.
- user preference candidates, project facts.
- decisions made, unresolved tasks.

### 14.3 원칙

- 운영 로그와 디지털 트윈 원천 데이터는 같은 테이블에 섞지 않는다.
- Provider raw event와 conversation transcript를 구분한다.
- Provider별 usage 필드는 공통 nullable schema로 정규화. "정확한 과금"이 아니라 "관측 메트릭"으로 취급.
- Langfuse는 P1 이후 optional. P0에서는 SQLite/local file에 저장.
- Redaction 대상: Telegram token, S3 key, provider auth token, API key pattern. persistence 전에 수행.

---

## 15. Security and Privacy Requirements

- root 실행 금지. 전용 Unix user 사용.
- `allowed_user_ids` 설정이 없으면 모든 메시지 무시 (필수).
- `TELEGRAM_BOT_TOKEN`, S3 key는 env 또는 systemd `EnvironmentFile`. raw log에 포함 금지.
- CLI subprocess 호출: 반드시 argv array. **string interpolation 방식 금지**.
- provider별 위험 플래그 기본 금지 (see [Appendix E](#appendix-e-위험-플래그-금지-목록)).
- provider별 `cwd` allowlist 관리.
- `max_runtime`, `max_output_bytes`, `max_prompt_bytes` 제한.
- cwd가 git repo인 경우 실행 후 diff 기록.
- raw log에 token/secret redaction 필수. persistence 전에 수행.

---

## 16. Failure Handling and Recovery

### 16.1 재시작 복구

앱 시작 시 아래 순서로 복구한다:

1. `status=running`이던 job → `interrupted`로 변경.
2. `attempts < max_attempts && safe_retry=true` → `queued`로 복구.
3. 그 외 → `failed` + Telegram 장애 알림.
4. orphan provider process 확인. 발견 시 종료 또는 관리자에게 경고.

### 16.2 Subprocess Lifecycle

- Provider subprocess는 독립 process group으로 실행 (`detached: true`).
- `proc.unref()` 기본 미호출. parent는 `proc.exited`를 추적하고 job state와 연결.
- cancel 또는 shutdown 시: SIGTERM → grace period → SIGKILL.
- side effect가 발생했을 수 있으면 `cancelled_after_start`로 기록.
- systemd `KillMode=control-group`은 마지막 안전망으로 사용.

### 16.3 Retry 정책

**retry 가능**:
- timeout (provider 시작 전).
- network transient error.
- provider overloaded.
- recognized rate limit message.
- JSON parse 실패이지만 raw output에 final answer 있는 경우 → parser fallback.

**retry 금지 (P0에서 자동 retry 금지)**:
- 파일 edit 포함 coding task.
- shell command 실행 task.
- provider가 일부 작업 완료 후 실패.
- Telegram 중복 응답 가능성 있는 경우.

### 16.4 독립 실패 처리

- S3 sync 실패 → `storage_sync` job 재시도. `provider_run` 상태 무영향.
- Telegram 알림 실패 → `notification_retry` job 재시도. `provider_run` 상태 무영향.
- `notification_retry`와 `storage_sync`는 서로 독립적으로 재시도.

---

## 17. Acceptance Criteria

| # | Criteria |
|---|----------|
| AC01 | Unauthorized Telegram user가 메시지를 보내면 job이 생성되지 않고 응답하지 않는다. 단, `BOOTSTRAP_WHOAMI=true`인 경우 `/whoami`만 예외적으로 `user_id`/`chat_id`를 반환할 수 있다. |
| AC02 | Authorized user가 DM을 보내면 하나의 job이 생성되고 status가 `queued → running → succeeded`로 전이된다. |
| AC03 | Claude subprocess stdout/stderr/redacted raw stream-json line이 `provider_raw_events`에 저장된다. |
| AC04 | final response가 Telegram으로 전송되고 `turns` 테이블에 assistant turn으로 저장된다. |
| AC05 | 동일 Telegram `update_id`가 중복 수신되어도 job은 한 번만 생성된다. |
| AC06 | app 재시작 시 running job은 `interrupted`로 전이되고, `safe_retry=true`인 경우만 `queued`로 복구된다. |
| AC07 | `/end` 또는 `/summary` 실행 시 session summary가 SQLite, local file에 저장되고 `storage_sync` job이 enqueue된다. |
| AC08 | S3 장애가 있어도 Telegram response delivery는 실패하지 않고 `storage_sync` job으로 별도 기록된다. |
| AC09 | max runtime/output/prompt limit 초과 시 provider subprocess가 종료되고 사용자에게 에러 요약이 전송된다. |
| AC10 | logs/raw events에 Telegram token, S3 secret, provider auth token이 저장되지 않는다. |
| AC11 | P0 Claude Code provider call은 interactive permission prompt를 요구하지 않는다. |
| AC12 | `storage_sync` job 실패는 `provider_run` job의 `succeeded` 상태를 되돌리지 않는다. |
| AC13 | memory summary 항목은 provenance와 confidence를 포함한다. |
| AC14 | running provider job `/cancel` 시 subprocess process group 전체가 종료된다. |
| AC15 | Claude stream-json parser fixture가 sample raw event를 `final_text`로 정상 정규화한다. |
| AC16 | `/doctor` 실행 시 S3 smoke test(put/get/stat/list/delete)가 성공해야 P0 acceptance를 통과한다. 실패 시 local-only degraded mode로 표시하고 `storage_sync` job은 retryable 상태로 남긴다. |
| AC17 | Telegram long polling은 direct fetch로 동작하고 bot framework dependency가 없다. |
| AC18 | `Bun.spawn` provider subprocess는 timeout/AbortSignal로 종료 가능하다. |
| AC19 | `bun:sqlite` WAL mode에서 job claim transaction이 재시작 후 일관성을 유지한다. |
| AC20 | P0 build/runtime dependency 목록은 PRD에 명시된 allowlist를 초과하지 않는다. |
| AC21 | `/doctor`는 exact Bun version을 표시하고, `required_bun_version`과 다르면 warning을 출력한다. |
| AC22 | Telegram `next_offset`은 update 처리 결과가 SQLite에 commit된 후에만 advance된다. |
| AC23 | app이 Telegram update 수신 후 job insert commit 전에 crash되어도, 해당 update는 재시작 후 다시 처리된다. |
| AC24 | Claude resume_mode에서는 full recent turns를 매 요청마다 재전송하지 않는다. |
| AC25 | Claude resume 실패 시 replay_mode로 fallback하고, 그 사실이 `provider_run`에 기록된다. |
| AC26 | Telegram sendMessage 실패는 `provider_run succeeded` 상태를 되돌리지 않고 `notification_retry` job으로 기록된다. |
| AC27 | `notification_retry` 실패와 `storage_sync` 실패는 서로 독립적으로 재시도된다. |
| AC28 | P0에서 `/provider gemini\|codex\|ollama` 요청은 provider를 전환하지 않고 `not_enabled` 메시지를 반환한다. |
| AC29 | `telegram_updates` 테이블은 received/enqueued/skipped/failed update를 기록한다. |
| AC30 | skipped update도 SQLite에 기록된 후에만 `telegram_next_offset`이 advance된다. |
| AC31 | `getUpdates`는 P0에서 `allowed_updates=["message"]`를 명시한다. |
| AC32 | Provider subprocess는 기본적으로 `proc.unref()` 없이 `proc.exited`로 추적된다. |
| AC33 | Claude advisory/chat mode smoke test는 Bash/Edit/Write/Read tool이 실행되지 않음을 검증한다. |
| AC34 | Claude read-only repo review mode smoke test는 Read/Grep/Glob만 허용됨을 검증한다. |
| AC35 | Claude 실행 중 interactive permission prompt가 발생하면 P0 acceptance 실패로 처리한다. |
| AC36 | `BOOTSTRAP_WHOAMI=true` 상태는 `/doctor`에서 warning으로 표시된다. |
| AC37 | bootstrap `/whoami`는 `user_id`/`chat_id` 외의 민감 정보를 반환하지 않는다. |
| AC38 | final response가 Telegram sendMessage 한도를 초과하면 여러 메시지로 chunking되어 순서대로 전송된다. |
| AC39 | chunk 전송 중 일부 실패 시 `provider_run succeeded` 상태는 유지되고 `notification_retry`로 복구된다. |
| AC40 | Telegram outbound notification은 `outbound_notifications`에 상태와 `telegram_message_ids`를 기록한다. |
| AC41 | `notification_retry`는 `outbound_notifications.status=failed` 또는 `pending` 상태만 재시도한다. |
| AC42 | Claude command builder는 첫 요청에는 `--session-id`, 후속 요청에는 `--resume`을 사용한다. |
| AC43 | `provider_session_id`가 존재하면 후속 resume에는 `provider_session_id`를 우선 사용한다. |
| AC44 | prompt가 `max_prompt_bytes` 또는 안전한 argv 길이를 초과하면 provider 실행 전 실패 처리된다. |
| AC45 | `summary_generation` job은 Claude advisory/chat lockdown profile로 실행된다. |
| AC46 | `summary_generation` output은 `memory_summaries` schema에 맞게 구조화되어 저장된다. |
| AC47 | P0에서 SQLite DB snapshot이 구현되는 경우 WAL mode에 안전한 backup 절차를 사용한다. |

---

## 18. Milestones

### P0 — MVP (Claude Vertical Slice)

- [ ] Claude Code adapter (session_args + permission_profile_args, lockdown smoke test 포함)
- [ ] SQLite job ledger + `telegram_updates` + `outbound_notifications` + single worker (concurrency 1)
- [ ] Telegram long polling (1:1 DM, direct fetch, `allowed_updates=["message"]`, offset durability, bootstrap whoami)
- [ ] Telegram response chunking
- [ ] Context Builder + Packer (resume_mode / replay_mode, conservative token estimator)
- [ ] Context injection 최소 버전 (retrieved memory 슬롯 비활성)
- [ ] 단기 memory + session summary 저장 (provenance 포함)
- [ ] `summary_generation` job (Claude advisory lockdown profile)
- [ ] S3 async sync (Bun.S3Client, driver abstraction, response delivery와 분리)
- [ ] notification과 storage_sync를 독립 post-processing job으로 처리
- [ ] 운영 로그 + redacted raw event 저장 (디지털 트윈 원천 데이터와 분리)
- [ ] subprocess process group 관리 (Bun.spawn detached, proc.exited tracking, no unref)
- [ ] systemd healthcheck + 재시작 복구
- [ ] Claude stream-json parser fixture test

### P1 — Claude 안정화 후

- [ ] Gemini CLI adapter (smoke test 통과 후 활성화)
- [ ] Ollama adapter (disabled by default)
- [ ] Gemini / Ollama parser fixture test
- [ ] retry/backoff 정책 고도화
- [ ] Langfuse optional integration
- [ ] Zod/Valibot schema validation
- [ ] Hono (admin API 필요 시)
- [ ] `@aws-sdk/client-s3` fallback (Bun.S3Client smoke test 실패 시)
- [ ] stdin/file-based prompt 전달 (Claude CLI 검증 후)

### P2 — 장기

- [ ] Codex CLI adapter
- [ ] cron/scheduler
- [ ] routing strategy (복잡도 기반 provider 자동 선택)
- [ ] Obsidian vault 연동
- [ ] 장기 memory retrieval (vector DB 등)
- [ ] 다차원 memory 구조 (단기/중기/장기 × 개인/프로젝트/회사)
- [ ] 웹검색 툴 주입
- [ ] Human approval UI for dangerous actions
- [ ] 파일 편집, 셸 실행, 배포, 마이그레이션

---

## 19. Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Claude CLI 버전 업데이트로 output format 변경 | High | parser fixture test, stream-json 포맷 검증 레이어, 버전 고정 |
| `--tools ""`가 기대대로 모든 tool을 비활성화하지 않음 | High | P0 acceptance lockdown smoke test 필수. 실패 시 `--disallowedTools`, isolated settings 등 대체 방식 검토 |
| CX22 메모리 부족 (기존 Langfuse + ClickHouse + 신규 서비스) | High | 경량 dependency, Ollama disabled by default, keep_alive 최소화 |
| Provider subprocess orphan process | Medium | 재시작 시 orphan 확인 및 종료. systemd `KillMode=control-group` |
| Bun.S3Client smoke test 실패 | Medium | local-only degraded mode로 동작. P0.5/P1에서 `@aws-sdk/client-s3` fallback |
| JSONL 파싱 오염 (stdout/stderr 혼재) | Medium | stderr classification, redacted raw event 저장, parser fallback 로직 |
| `BOOTSTRAP_WHOAMI=true` 방치 | Low | `/doctor` warning. production steady-state 전 비활성화 확인 |
| Memory poisoning via assistant 추론 | Low | provenance tracking. `tool_output`/`assistant_generated`/`inferred`는 장기 personal preference 승격 금지 |
| Telegram 중복 응답 | Low | idempotency_key, `outbound_notifications` 기록, payload_hash 중복 감지 |
| Codex auth 환경 충돌 (OPENAI_API_KEY 충돌) | Low (P2) | `OPENAI_API_KEY` env isolation 검증, auth 환경 별도 확인 |

---

## 20. Open Questions

1. Claude `--tools ""`가 모든 tool을 비활성화하지 못하는 경우, `--disallowedTools` vs isolated settings 중 어떤 대체 방식을 우선 적용할 것인가?
2. SQLite DB snapshot S3 upload를 P0에서 구현할 것인가, P1으로 미룰 것인가?
3. Claude stream-json JSONL 파싱 실패 시 raw output에서 final answer 복구 로직의 신뢰성 기준은?
4. Gemini CLI의 설치된 버전에서 resume + output-format 조합이 동작하는지 P0 이전에 검증해야 하는가?
5. `summary_generation`의 turns 선택 기준 — 최근 N개 turn vs. 전체 세션 turn?
6. `notification_retry` 최대 시도 횟수 및 backoff 전략?
7. `max_prompt_bytes` 안전한 argv 길이 기준값 (OS별 차이가 있음)?
8. WAL mode SQLite에서 backup API 사용 시 장시간 provider_run 중 backup 타이밍?

---

## 21. Appendix

### Appendix A: 권장 디렉토리 구조

```
src/
  main.ts
  config.ts
  db.ts
  telegram.ts
  queue.ts
  worker.ts
  context/
    builder.ts
    packer.ts
    token_estimator.ts
  providers/
    types.ts
    claude.ts
  memory/
    summary.ts
    provenance.ts
  storage/
    local.ts
    s3.ts
  observability/
    redact.ts
    events.ts
  commands/
    status.ts
    cancel.ts
    doctor.ts
test/
  fixtures/
    claude-stream-json/
  claude-parser.test.ts
  queue-state.test.ts
  redaction.test.ts
```

### Appendix B: AgentRequest / AgentResponse 필드

**AgentRequest**

| 필드 | 타입 | 설명 |
|------|------|------|
| `provider` | string | 프로바이더 이름 |
| `message` | string | 사용자 메시지 |
| `session_id` | uuid | 내부 세션 UUID |
| `user_id` | string | Telegram user_id |
| `channel` | string | `telegram:<chat_id>` |
| `chat_id` | string | Telegram chat_id |
| `project_id` | string? | optional |
| `cwd` | string? | optional |
| `system_context` | string? | 주입할 시스템 컨텍스트 |
| `injected_memory` | string? | 주입할 메모리 |
| `attachments` | any[]? | 첨부 |
| `timeout_s` | number? | 타임아웃 |
| `priority` | number? | 우선순위 |
| `idempotency_key` | string? | 멱등성 키 |
| `metadata` | object? | 기타 메타데이터 |

**AgentResponse**

| 필드 | 타입 | 설명 |
|------|------|------|
| `provider` | string | 프로바이더 이름 |
| `session_id` | string | `provider_session_id` |
| `final_text` | string | 최종 응답 텍스트 |
| `raw_events` | any[] | raw stream events |
| `usage` | object? | token usage |
| `cost` | number? | 비용 추정 |
| `duration_ms` | number | 소요 시간 |
| `exit_code` | number | subprocess exit code |
| `error_type` | string? | 에러 타입 |
| `stderr` | string? | redacted stderr |
| `artifacts` | any[]? | 생성된 아티팩트 |
| `provider_version` | string? | provider CLI 버전 |

### Appendix C: ID 체계

| ID | 설명 |
|----|------|
| `user_id` | Telegram user_id |
| `channel_id` | `telegram:<chat_id>` |
| `session_id` | 내부 UUID (영속적) |
| `provider_session_id` | Claude/Codex/Gemini가 반환한 session id (깨질 수 있음) |
| `project_id` | optional |
| `job_id` | 내부 UUID |
| `turn_id` | 내부 UUID |
| `storage_key` | S3 object key |

### Appendix D: SQLite 스키마

**주요 테이블 목록**

```
telegram_updates
outbound_notifications
jobs
sessions
turns
provider_runs
provider_raw_events
memory_summaries
storage_objects
allowed_users
settings
```

**`telegram_updates`**

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `update_id` | INTEGER UNIQUE | Telegram update_id (idempotency_key) |
| `chat_id` | TEXT | |
| `user_id` | TEXT | |
| `update_type` | TEXT | |
| `status` | TEXT | `received` \| `enqueued` \| `skipped` \| `failed` |
| `skip_reason` | TEXT | nullable |
| `job_id` | TEXT | nullable |
| `raw_update_json_redacted` | TEXT | |
| `created_at` | DATETIME | |
| `processed_at` | DATETIME | nullable |

**`outbound_notifications`**

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | TEXT | UUID |
| `job_id` | TEXT | |
| `chat_id` | TEXT | |
| `notification_type` | TEXT | `job_accepted` \| `job_completed` \| `job_failed` \| `job_cancelled` \| `summary` \| `doctor` |
| `payload_hash` | TEXT | |
| `status` | TEXT | `pending` \| `sent` \| `failed` |
| `telegram_message_ids_json` | TEXT | nullable |
| `attempt_count` | INTEGER | |
| `error_json` | TEXT | nullable |
| `created_at` | DATETIME | |
| `sent_at` | DATETIME | nullable |

**`jobs`**

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | TEXT | UUID |
| `status` | TEXT | `queued` \| `running` \| `succeeded` \| `failed` \| `cancelled` \| `interrupted` |
| `job_type` | TEXT | `provider_run` \| `summary_generation` \| `storage_sync` \| `notification_retry` |
| `priority` | INTEGER | |
| `scheduled_at` | DATETIME | |
| `created_at` | DATETIME | |
| `started_at` | DATETIME | nullable |
| `finished_at` | DATETIME | nullable |
| `attempts` | INTEGER | |
| `max_attempts` | INTEGER | |
| `provider` | TEXT | nullable (non-provider jobs) |
| `session_id` | TEXT | nullable |
| `user_id` | TEXT | nullable |
| `chat_id` | TEXT | nullable |
| `request_json` | TEXT | |
| `result_json` | TEXT | nullable |
| `error_json` | TEXT | nullable |
| `idempotency_key` | TEXT | |
| `safe_retry` | BOOLEAN | |

**`provider_raw_events`**

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | TEXT | UUID |
| `provider_run_id` | TEXT | |
| `event_index` | INTEGER | |
| `stream` | TEXT | `stdout` \| `stderr` |
| `redacted_payload` | TEXT | |
| `redaction_applied` | BOOLEAN | |
| `parser_status` | TEXT | `unparsed` \| `parsed` \| `fallback_used` \| `parse_error` |
| `created_at` | DATETIME | |

**`memory_summaries`**

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | TEXT | UUID |
| `session_id` | TEXT | |
| `summary_type` | TEXT | `session` \| `project` \| `daily` |
| `facts_json` | TEXT | |
| `preferences_json` | TEXT | |
| `open_tasks_json` | TEXT | |
| `decisions_json` | TEXT | |
| `cautions_json` | TEXT | |
| `provenance_json` | TEXT | |
| `confidence_json` | TEXT | |
| `source_turn_ids` | TEXT | JSON array |
| `created_at` | DATETIME | |
| `storage_key` | TEXT | nullable (S3 key) |

### Appendix E: 위험 플래그 금지 목록

| Provider | 금지 플래그 |
|----------|------------|
| Claude | `--dangerously-skip-permissions`, `--no-session-persistence` (기본값 사용 금지) |
| Codex | `--dangerously-bypass-approvals-and-sandbox`, `--yolo` |
| Gemini | `--yolo`, `approval-mode=yolo` |

### Appendix F: Bun Version 고정 정책

- Exact patch version 고정. range pinning 금지 (예: `1.3.x` 금지).
- `.bun-version` 또는 `config/runtime.json`에 `required_bun_version` 명시.
- systemd 배포 환경과 local dev 환경의 Bun version 일치 필수.
- `/doctor`는 `bun --version`과 `required_bun_version` 비교. mismatch 시 warning 출력.
- production startup에서 version mismatch를 block할지는 설정으로 제어.
