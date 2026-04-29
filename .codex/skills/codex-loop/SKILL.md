---
name: codex-loop
description: 현재 PR의 codex 리뷰를 기다리고 코멘트 수정 후 push, 통과 reaction을 받으면 정책에 맞춰 merge
---

현재 작업 중인 PR에 대해 codex 리뷰를 기다리고, 코멘트가 달리면 수정 후 push. 통과 reaction까지 반복한 뒤 PR을 정책에 맞춰 merge한다.

## 핵심 원칙: 대기 사이클마다 foreground 확인 1회

각 대기 사이클은 GitHub app 또는 `gh` CLI를 사용해 foreground에서 1회 확인한다.
feedback을 수정하고 push한 뒤에는 다음 대기 사이클로 보고 같은 확인 절차를 다시
실행한다. background polling을 남기지 않는다.

```bash
gh pr view --json number,url,isDraft,baseRefName,headRefName,mergeStateStatus,reviewDecision
gh pr checks <PR_NUMBER> --watch
gh pr view <PR_NUMBER> --comments
```

다음 패턴은 금지한다.

- `bash ... &` 로 background polling
- background 실행 후 주기적 output 확인
- 매 sleep 사이에 PR 상태를 다시 polling
- 별도 monitor 도구로 stream watch

## 절차

1. PR 만든 직후, 또는 push 직후, GitHub app으로 PR 상태와 review/comment를 확인한다.
2. GitHub app으로 필요한 상태를 볼 수 없으면 `gh pr view`, `gh pr checks --watch`,
   `gh pr view --comments`를 foreground로 실행한다.
3. 결과에 따라 처리한다.

| 상태 | 다음 행동 |
| ---- | --------- |
| Codex pass reaction 감지 | checks 확인 후 PR merge |
| 새 comment/review 발견 | 분석 -> 수정 -> commit -> push -> 확인 절차 재실행 |
| checks pending | `gh pr checks <PR_NUMBER> --watch` foreground 실행 |
| timeout | 사용자에게 타임아웃 보고 |
| PR 감지 실패 | PR 번호 또는 URL 요청 후 재확인 |
| 영구 API 오류 | 인증/권한 문제 보고 |

## Feedback 처리

- 코멘트가 모호하거나 우선순위 판단이 필요하면 코드 수정 전 사용자에게 확인한다.
- 이미 처리된 이슈, 재현 불가 항목, 범위 밖 요구는 근거를 남기고 제외할 수 있다.
- 수정은 최소 diff로 하고, 관련 테스트와 repo가 정의한 검증 명령을 다시 실행한다.
- push 후 GitHub app 또는 `gh` 확인 절차를 다시 foreground로 실행한다.

## Merge 처리

exit 0은 Codex pass reaction을 감지했다는 뜻이다. 이 경우 사용자의 추가 확인을
기다리지 말고 PR을 merge한다. 단, merge 전 다음을 확인한다.

1. PR이 draft가 아니어야 한다.
2. required checks가 통과해야 한다.
3. 새 actionable comment/review가 없어야 한다.
4. repo-local guidance 또는 GitHub repo 설정이 정한 merge 방식을 따른다.

권장 확인:

```bash
gh pr view --json number,url,isDraft,baseRefName,headRefName,mergeStateStatus,reviewDecision
gh pr checks <PR_NUMBER> --watch
gh api "repos/<owner>/<repo>" --jq '{allow_merge_commit, allow_squash_merge, allow_rebase_merge}'
```

merge 방식 선택:

- repo-local guidance가 `squash merge`를 요구하면 `gh pr merge <PR_NUMBER> --squash --delete-branch`.
- repo가 merge commit만 허용하면 `gh pr merge <PR_NUMBER> --merge --delete-branch`.
- repo가 rebase merge만 허용하면 `gh pr merge <PR_NUMBER> --rebase --delete-branch`.
- 명시 정책이 없고 여러 방식이 허용되면 기존 repo 관례를 따른다. 관례가 불명확하면 `--squash`를 기본값으로 사용한다.

branch protection, merge queue, required check pending 때문에 즉시 merge가 막히면 같은 방식에 `--auto`를 붙여 auto-merge를 걸 수 있다. 그래도 막히면 차단 사유와 PR URL을 사용자에게 보고한다.

## 완료

PR URL, merge 방식, check 결과, 처리한 feedback, 남은 리스크를 보고한다.
