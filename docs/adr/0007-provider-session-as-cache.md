# ADR-0007 — Provider Session is a Cache; Internal Session is the Source of Truth

- Status: accepted
- Date: 2026-04-22
- Supersedes: —
- Superseded by: —

## Context

Claude Code exposes `--session-id` and `--resume` to let the runtime
reuse a conversation and save tokens. Treating Claude's session as
the conversation's source of truth would mean: if Claude drops a
session (upgrade, eviction, internal state loss), we lose the
conversation.

For a personal agent that aims to build a long-term usage record for
a future digital twin, that failure mode is unacceptable. We need
to be able to reconstruct any conversation from our own storage
regardless of Claude's state.

## Decision

Treat **provider session as a cache** and **internal SQLite state as
the source of truth**:

- The authoritative conversation state lives in
  `sessions`, `turns`, `memory_summaries`, and `memory_items`.
- `provider_session_id` is stored on the `sessions` row as an
  optimization hint — it enables `--resume` when valid.
- Two context-packing modes codify the fallback (HLD §10.2):
  - `resume_mode` — valid `provider_session_id`; send only the
    user message + compact injected context; no recent-turn
    replay.
  - `replay_mode` — no valid `provider_session_id` (new session,
    lost session, upgrade mismatch, `--resume` failed); send
    current session summary + recent N turns + user message.
- A failed `--resume` does **not** silently fall back mid-call.
  The adapter exits and the worker re-queues the job with the
  same idempotency key in `replay_mode`. This keeps semantics
  testable (SP-06).
- Recent turns are never replayed in `resume_mode` — replay is the
  fallback, not a belt-and-suspenders strategy.

## Alternatives considered

- **Always rely on `--resume`** — cheapest tokens; fails hard the
  first time Claude drops a session.
- **Always use `replay_mode`** — deterministic but burns tokens
  unnecessarily for the common case.
- **Silent fallback to replay inside one call** — hides failure
  modes and makes spike SP-06 harder to reason about.

## Consequences

- SP-06 must prove three things: `--session-id` creates a usable
  session, `--resume` continues it, a broken session fails
  deterministically, and `replay_mode` from SQLite-only produces
  coherent continuation (Q-014).
- `provider_runs.context_packing_mode` is recorded per run before
  spawn so logs always reflect the actual mode even if the
  subprocess dies.
- Telegram message chunking and long-term memory remain unaffected
  by Claude's session lifecycle.

## Risks and mitigations

| Risk                                                 | Mitigation                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| `--resume` is unreliable on a given Claude version   | Default to `replay_mode` at startup; `resume_mode` opt-in per session (configurable). |
| Silent mid-call resume→replay fallback sneaks in     | SP-06 fixture + HLD §8.2 invariant; code review enforces.       |
| Token cost spike when many sessions fall to replay   | `/status` surfaces packing mode; optimize packer before flipping defaults. |

## Review trigger

Revisit if SP-06 reveals that `--resume` is not reliably
distinguishable from a silently-broken session (we would flip the
default to `replay_mode` and make resume opt-in), or if Claude
Code's session model changes materially.

## Refs

- PRD §12.4 (packing modes).
- HLD §8.2 (adapter resume vs replay), §10.2 (decision).
- SP-06 in `docs/03_RISK_SPIKES.md`.
- Q-014 in `docs/07_QUESTIONS_REGISTER.md`.
