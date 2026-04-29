---
name: dev-cycle
description: "전체 개발 사이클: sync -> discover -> implement -> verify -> review -> ship. 플래그: --loop [N], --phase <id>"
---

# Dev Cycle

## Flags

- `--loop`: cycle 완료 후 Step 1부터 반복한다. Step 3에서 **ALL CLEAR**이면 종료한다.
- `--loop N`: 정확히 N회 반복한다.
- `--phase <id>`: 탐색과 구현 범위를 해당 roadmap/task/phase id로 제한한다. 값을 파싱하거나 변환하지 않는다.

## Invariants

- Step이 끝나면 사용자 입력 없이 다음 Step으로 진행한다.
- 멈추는 경우: **ALL CLEAR**, 사용자 승인 없이는 안전하지 않은 분기, 인증/권한/destructive git state, 해결 불가 blocker.
- repo type, review base, sync, brief log, risk issue 처리는 현재 repo 상태와
  GitHub app / `gh` CLI 결과를 직접 확인해 수행한다.

## Brief Log

새 실행의 첫 cycle에서 현재 branch, base, 작업 목표, 검증 결과, 남은 risk를
간단한 bullet로 유지한다. 이어서 실행하는 cycle이면 git log/status와 이전
대화의 brief를 대조해 현재 loop의 직전 cycle만 복원한다.

Cycle 종료 시 결과를 아래 필드로 정리한다. **ALL CLEAR, blocked, publish 금지로
종료하는 경우도 brief를 먼저 남긴다.** `Risk`가 비어 있지 않고 GitHub issue가
필요하면 GitHub app 또는 `gh issue create`로 만든 뒤 issue URL을 기록한다.

- Cycle: `<N>`
- Result: `<DOC FIX / NEXT TASK / ALL CLEAR / shipped / blocked>`
- Work: `<주요 변경 또는 판단 1줄>`
- Verification: `<검증 결과>`
- Review / Ship: `<review/ship 결과>`
- Risk: `<남은 리스크 또는 없음>`
- Next action: `<리스크 후속 작업>`

## Step 1 - Sync

```bash
git status -sb
git branch --show-current
git fetch origin
git remote show origin
```

repo type과 review base는 직접 판단한다. default branch에서 직접 push하는 repo면
`Direct-push repo`, PR branch를 쓰는 repo면 `Standard repo`로 본다. review base는
현재 branch의 upstream/base ref, PR base, 또는 default branch 중 repo guidance와
일치하는 값을 사용한다.

## Step 2 - Discover

로컬에서 직접 탐색한다. 읽기 순서는 repo guidance/README, roadmap과 thin docs, task 관련 source/tests 순서다. 긴 design/archive/generated 문서는 필요할 때만 읽는다.

판단 기준:

- 구현 후보를 우선한다.
- docs-only는 구현할 코드 작업이 없고 문서만 틀린 경우에만 선택한다.
- 문서와 코드가 둘 다 필요하면 구현 작업으로 반환하고 docs update를 acceptance criteria에 포함한다.
- `--phase <id>`가 있으면 해당 id 범위만 본다.

반환은 아래 중 하나:

**## NEXT TASK**
파일/영역, acceptance criteria, docs update, validation을 포함한 하나의 작업.

**## DOC FIX NEEDED**
docs-only 수정 목록.

**## ALL CLEAR**
현재 상태 요약.

## Step 3 - Decide

- **ALL CLEAR**: brief를 남긴 뒤 종료한다.
- **NEXT TASK**: Step 4로 간다.
- **DOC FIX NEEDED**: Step 4로 가되 작업 type은 `docs`.

## Step 4 - Implement

- Direct-push repo: `main`에서 직접 작업한다.
- Standard repo: default branch에서 시작했다면 `codex/<short-description>` 또는 `<type>/<short-description>` 브랜치를 만들고, 이미 작업 브랜치면 유지한다.
- `update_plan`으로 작은 작업 단위를 만들고, 수동 편집은 `apply_patch`를 사용한다.
- Step 2의 task를 구현한다. docs update가 acceptance criteria면 같은 cycle에서 처리한다.
- `--phase <id>` 범위를 벗어난 작업은 하지 않는다.

## Step 5 - Verify

`verify` 스킬 절차를 같은 세션에서 수행한다. 완료 후 멈추지 말고 분기한다.

- pass 또는 누락 수정 완료: Step 6.
- 해결 불가 blocker: `DEV_CYCLE_RESULT="blocked"`로 `finish-cycle`을 실행하고 중단.

## Step 6 - Review

리뷰 직전 review base를 다시 계산한다.

```bash
git status -sb
git branch --show-current
git merge-base HEAD origin/main
```

default branch가 `main`이 아니면 repo guidance / PR base에 맞는 origin ref로
바꿔 계산한다.

- Direct-push repo: local diff, staged diff, untracked files, 또는 unpublished `origin/main...HEAD`를 리뷰한다.
- Standard repo: `$REVIEW_BASE...HEAD` 기준으로 리뷰한다.
- Review Pass는 diff review와 impact triage/scan이 함께 통과한 상태다. impact scan을 review OK 이후 별도 단계로 두지 않는다.
- Impact triage: docs/typo/leaf/test-only처럼 외부 surface가 없으면 `Impact: local only`로 끝낸다.
- 위험 trigger: shared helper/API, command/skill, deploy/build/test infra, config/env/schema, persistence, auth/security, public CLI/output, 파일 경로/계약 변경, 변경 파일 5개 초과. 해당하면 변경된 symbol/path/env/command를 `rg`로 repo 전체에서 추적해 call site/docs/tests/deploy refs를 확인한다.
- 버그, regression, missing test, security/auth/data-loss, schema/runtime/docs 불일치 findings를 batch로 정리한다. actionable finding은 같은 cycle에서 한 번에 수정하고 targeted verify 후 Review Pass를 반복한다.
- fix가 surface를 넓히지 않았으면 다음 pass는 추가 diff 중심으로 본다.
- 최대 5회 반복한다. 5회 후 남은 actionable finding은 GitHub issue로 남기고 Step 7로 간다.

## Step 7 - Local Checks

repo guidance와 docs/testing에 정의된 full/pre-PR 검증을 실행한다. 실패하면 수정 후 Step 7을 반복한다.

## Step 8 - Ship

- Direct-push repo: 의도한 파일만 stage, commit, `git push origin main`. PR은 만들지 않는다.
- Standard repo: 의도한 파일만 stage, commit, 현재 branch push, GitHub app 또는 `gh pr create --base "$REVIEW_BASE" --draft=false`, `codex-loop`, 통과 시 squash merge.
- 사용자가 publish 금지를 명시했으면 여기서 멈추고 local state만 보고한다.

## Loop

`--loop` 또는 `--loop N`이면 cycle brief를 append한 뒤 Step 1로 돌아간다. 이어받은 cycle에서는 brief log의 run id와 git log를 확인해 현재 loop의 이전 cycle만 복원한다.

종료 시 cycle brief를 근거로 전체 결과를 8줄 이내로 보고한다.
