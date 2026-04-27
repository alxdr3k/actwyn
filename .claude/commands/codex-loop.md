현재 작업 중인 PR에 대해 codex 리뷰를 기다리고, 코멘트가 달리면 수정 후 푸시. PR 본문에 👍가 달릴 때까지 반복.

## 절차

1. `bash .claude/scripts/wait-codex-review.sh` 실행 (PR 번호가 자동 감지 안 되면 인자로 전달)
2. 종료 코드에 따라:
   - **0**: PR 본문에 👍 → 리뷰 통과. 종료.
   - **1**: stdout에 새 코멘트 출력됨 → 내용을 분석해 코드 수정 → commit → push → 1번부터 재시도.
   - **2**: 타임아웃 → 사용자에게 알리고 종료.
   - **3**: PR 미감지 → 첫 인자로 PR 번호 전달.

## 환경변수

- `CODEX_POLL_INTERVAL` (기본 30초): 폴링 간격
- `CODEX_POLL_TIMEOUT` (기본 3600초): 전체 대기 한도
- `CODEX_PASS_EMOJI` (기본 👍): 리뷰 통과 신호
- `CODEX_BASELINE`: 이 timestamp 이전 코멘트는 무시

## 주의

- push 후에는 baseline이 자동 갱신되도록 스크립트를 재실행.
- 코멘트가 모호하거나 우선순위 판단이 필요하면 수정 전에 사용자에게 확인.
