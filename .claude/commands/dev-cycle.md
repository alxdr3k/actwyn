---
description: 전체 개발 사이클: pull → doc 정합성 감사(codex) → 구현 → verify → review → ship
---

# Dev Cycle

아래 단계를 순서대로 실행하라.

---

## 리포지토리 유형 정의

**Direct-push 리포 (main에 직접 커밋/push):**
- actwyn
- concluv

그 외 모든 리포는 **Standard 리포** (feat/* → dev → main PR 워크플로우).

Phase 시작 전 `git remote get-url origin` 으로 리포 이름을 확인하고, 이후 모든 분기 판단에 사용한다.

---

## Phase 1 — Sync (Claude 실행)

```bash
git fetch origin
git pull origin main
```

---

## Phase 2–4 — 문서 정합성 감사 & 다음 작업 식별 (codex:rescue 위임)

`codex:rescue` 스킬을 호출하여 다음 프롬프트를 전달하라:

---

이 리포지토리의 문서와 구현 상태의 정합성을 감사하고, 다음 작업을 식별하라.

**수행 절차:**

1. 모든 문서 파일을 읽어라 (README.md, CLAUDE.md, ARCHITECTURE.md, docs/**, 기타 문서 파일)
2. 현재 구현 상태를 파악하라:
   - `git log --oneline -30`으로 최근 커밋 흐름 확인
   - 주요 소스 디렉토리 및 파일 탐색
3. 문서와 코드 사이의 불일치를 식별하라:
   - 문서에 있지만 미구현된 기능
   - 구현되었지만 문서에 없는 기능
   - 오래되거나 잘못된 설명
4. TODO, 미완성 구현, 개선 가능한 부분에서 다음 작업을 도출하라

**반환 형식 — 아래 중 정확히 하나를 선택:**

**## DOC FIX NEEDED**
[파일명과 수정 내용을 포함한 구체적인 불일치 목록. Claude가 바로 실행 가능한 프롬프트 형태로 작성.]

**## NEXT TASK**
[다음 구현할 기능이나 개선 작업의 명확한 프롬프트. 충분한 컨텍스트 포함.]

**## ALL CLEAR**
[현재 상태 요약. 추가 작업 없음.]

---

codex:rescue의 출력 결과를 파싱하여 다음 Phase의 행동을 결정한다.

---

## Phase 3–5 — 브랜치 & 구현 (Claude 실행)

**ALL CLEAR인 경우:** 사용자에게 현재 상태를 보고하고 중단한다.

**Direct-push 리포:** `main` 브랜치 그대로 유지, 직접 커밋

**Standard 리포:**
- Doc fix: `git checkout -b docs/<짧은-설명>`
- 기능 구현: `git checkout -b feat/<짧은-설명>`

Phase 2–4에서 받은 프롬프트(DOC FIX NEEDED 또는 NEXT TASK)를 실행한다.

---

## Phase 6 — Verify (Claude 실행)

`/verify` 커맨드를 실행한다.

---

## Phase 7 — Code Review 루프 (Claude 실행)

구현 작업 규모를 먼저 판단한다:

- **깊은 리뷰 필요 기준:** 변경된 파일 5개 초과, 또는 새 기능/아키텍처 변경, 또는 보안·인증 관련 코드 포함

### 리뷰 루프

| 회차 | 깊은 리뷰 필요 시 | 일반 시 |
|------|-----------------|---------|
| 1회차 | `/codex:adversarial-review` | `/codex:review` |
| 2회차 | `/codex:adversarial-review` | `/codex:review` |
| 3회차~ | `/codex:review` | `/codex:review` |

**루프 절차:**
1. 위 표에 따라 적절한 리뷰 스킬을 실행한다
2. 리뷰 결과가 **pass**이면 Phase 8로 진행한다
3. 리뷰 결과에 지적 사항이 있으면 수정 후 `/verify` 재실행, 그 다음 회차 리뷰로 반복한다
4. pass가 나올 때까지 반복한다

---

## Phase 8 — Ship (Claude 실행)

**Direct-push 리포:**

```bash
git push origin main
```

**Standard 리포:**

1. `gh pr create --base dev --draft=false` 로 PR 생성 (제목/본문 적절히 작성)
2. `/codex-loop` 커맨드를 실행한다
3. codex-loop 완료 후 해당 PR을 `dev` 브랜치에 **squash merge**한다
