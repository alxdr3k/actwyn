# ADR-0004 — Use S3 as an Artifact Archive, Not an Active Memory DB

- Status: accepted
- Date: 2026-04-22
- Supersedes: —
- Superseded by: —

## Context

Early framing of the project described S3 as "memory storage", which
blurred the line between durable binary objects (images, attachments,
generated artifacts, snapshots) and active state (session / memory /
turn metadata, provenance, linkage). That framing led to confusion
about where meaning should live and where retention policy applies.

Hetzner Object Storage is an S3-compatible bucket/object store that
treats objects as immutable once written; it is not designed to
serve as an active DB for fine-grained state updates.

## Decision

Draw a hard line between three stores and enforce single-writer
responsibilities:

- **SQLite** owns state, meaning, index, provenance, retention
  class, and linkage.
- **Local filesystem** owns ephemeral working copies and temp files.
- **S3 (Hetzner Object Storage)** holds the durable originals:
  attachments the user explicitly saves, generated artifacts,
  transcript snapshots, memory snapshots.

An S3 object viewed in isolation must not reveal *why* it was
stored. All meaning lives in SQLite (`storage_objects`,
`memory_artifact_links`, `memory_summaries`). Object keys follow a
fixed, opaque pattern:
`objects/{yyyy}/{mm}/{dd}/{object_id}/{sha256}.{safe_ext}`. No
original filename, user name, chat id, or project name appears in
the key.

## Alternatives considered

- **S3 as primary memory store with SQLite as a cache** — breaks
  atomic state transitions, creates eventual-consistency bugs.
- **Dual-write semantics** (meaning stored in both SQLite and S3
  object metadata) — doubles the writer surface and makes
  consistency testing harder.
- **Local filesystem only** — loses durability across host failure.

## Consequences

- The Artifact Storage Policy (PRD §12.8) codifies artifact types,
  retention classes (`ephemeral` / `session` / `long_term` /
  `archive`), and explicit-save-first promotion (ADR-0006).
- `storage_sync` is an independent, retryable job; a failure never
  rolls back a `provider_run` success (HLD §6.4, §12.4, AC12, AC25).
- Degraded-mode operation: user replies keep flowing even while S3
  is unreachable; backlog is surfaced via `/status` and `/doctor`.

## Risks and mitigations

| Risk                                                      | Mitigation                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| Operators still call S3 "memory" in incidents             | Glossary in HLD §5; Runbook §7 uses "artifact archive".      |
| Long S3 outages fill the local disk                       | Concrete thresholds in Runbook §7 + Q-023 decision.          |
| Key pattern leaks PII if violated                         | AC24 enforces key shape; grep CI check over produced keys.   |

## Review trigger

Revisit if we introduce active memory retrieval (P1+) or
client-side encryption (P1+), either of which may blur the boundary
and require an explicit addendum.

## Refs

- PRD §12.7 (bucket config), §12.8 (artifact storage policy),
  Appendix D, AC08, AC12, AC16, AC21–AC25.
- HLD §6.4, §9.3, §12.
- SP-08 in `docs/03_RISK_SPIKES.md`.
- Q-008 in `docs/07_QUESTIONS_REGISTER.md` (where meaning lives).
