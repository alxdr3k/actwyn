# ADR-0006 — Explicit Memory and Attachment Promotion

- Status: accepted
- Date: 2026-04-22
- Supersedes: —
- Superseded by: —

## Context

In a single-user personal agent, automatic long-term memory
accumulation creates three failure modes that are hard to walk back:

1. **Privacy leaks** — files or facts the user didn't intend to
   keep become part of the durable record.
2. **Memory poisoning** — inferred or observed items that later
   turn out to be wrong calcify into "facts" the agent references.
3. **Storage bloat** — the durable store grows without a clear
   deletion policy.

P0 has no human-approval UI and no confirmation-flow infrastructure
beyond Telegram text. The choice of default policy matters now
because reversing it later requires deleting data the user never
meant to keep.

## Decision

Adopt an **explicit-save-first** policy for all long-term memory
and durable artifacts:

1. **Attachments**: Telegram attachments default to
   `retention_class = session`. Promotion to `long_term` requires an
   explicit user signal — a `/save_last_attachment` command **or** a
   natural-language phrase ("save this", "remember this file", "keep
   this for later").
2. **Memory items**: new facts, preferences, decisions, open tasks,
   and cautions are captured in session summaries with provenance
   (`user_stated` / `user_confirmed` / `observed` / `inferred` /
   `tool_output` / `assistant_generated`). Only `user_stated` and
   `user_confirmed` items are eligible for promotion to long-term
   memory.
3. **Forget commands** exist from P0 and are tombstone-based:
   `/forget_last`, `/forget_session`, `/forget_artifact <id>`,
   `/forget_memory <id>`. They mark items `revoked` / `deleted`
   rather than hard-deleting rows.
4. **Corrections supersede, not overwrite**: a `user_stated`
   correction creates a new memory item with
   `supersedes_memory_id` pointing at the prior item; the prior
   item moves to `superseded` and is dropped from context packing.

Automatic confidence-based promotion is deferred to P1+ and requires
a dedicated UX for review and correction before it is adopted.

## Alternatives considered

- **Auto-save everything** — maximizes recall but trades away user
  control and privacy; unacceptable for a personal agent.
- **Auto-save behind a confidence heuristic** — requires a
  confidence metric we have not yet validated; too much
  infrastructure for P0.
- **Single `/forget` command with a follow-up scope question** —
  overloads one command and adds conversational state we don't
  otherwise need in P0.

## Consequences

- PRD §12.8.3 (explicit-save-first) and §12.2 (provenance gate) are
  codified policy.
- New tables: `memory_items` (per-item lifecycle with
  `status: active | superseded | revoked`) and
  `memory_artifact_links` (relation + provenance) — Appendix D.
- `storage_objects.status` adds `deletion_requested` and
  `delete_failed` to support forget flows (HLD §6.4).
- Acceptance tests AC22, AC23 enforce the negative case (no
  promotion without intent) and the positive case (linked with
  `provenance ∈ {user_stated, user_confirmed}`).

## Risks and mitigations

| Risk                                                         | Mitigation                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------- |
| User forgets to save something they wanted to keep           | Session-scoped copies remain during the session; UX surfaces saved/not-saved state (Q-017). |
| Forget command accidentally deletes too much                 | Scoped commands (`_last` / `_session` / `_artifact` / `_memory`) rather than one overloaded `/forget`; tombstones allow reversal in ops. |
| Confidence-based P1 promotion blurs the boundary             | Treat P1 promotion as a new ADR that supersedes this one.        |

## Review trigger

Revisit when we introduce P1 confidence-based promotion UX or when
retention-class policy changes.

## Refs

- PRD §12.2, §12.8, §17 AC21–AC25.
- HLD §6.4, §9.3, §11.3.
- Q-004, Q-005, Q-006, Q-007 in `docs/07_QUESTIONS_REGISTER.md`.
- DEC-012 (/forget command set), DEC-013 (correction via supersede).
