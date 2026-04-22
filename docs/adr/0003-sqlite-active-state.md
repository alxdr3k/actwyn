# ADR-0003 — Use SQLite (WAL) as the Active State Source of Truth

- Status: accepted
- Date: 2026-04-22 (codified from pre-project decision)
- Supersedes: —
- Superseded by: —

## Context

The Personal Agent has multiple state machines (`telegram_updates`,
`jobs`, `outbound_notifications`, `storage_objects`, and internal
session / memory state) that must survive restarts and be consistent
under crash. We need durable storage with atomic multi-row updates,
running on a single Hetzner CX22 host (2 vCPU, 4 GB RAM) that also
hosts other services.

## Decision

Use **SQLite in WAL mode** as the single source of truth for all
active state: `telegram_updates`, `jobs`, `sessions`, `turns`,
`provider_runs`, `provider_raw_events`, `memory_summaries`,
`memory_items`, `storage_objects`, `memory_artifact_links`,
`outbound_notifications`, `allowed_users`, `settings`.

The database file lives on the host's local disk. S3 is the
**archive** layer for durable binary artifacts (ADR-0004), never a
substitute for SQLite state.

## Alternatives considered

- **PostgreSQL on the same host** — heavier memory footprint, more
  ops surface, extra failure modes; unnecessary for one writer and
  one user.
- **Managed/remote Postgres** — introduces network latency on every
  hot path (`BEGIN IMMEDIATE` claim, offset advance) and an extra
  failure mode.
- **File-based append-only log** — would force us to hand-roll
  atomicity and indexing for several state machines.

## Consequences

- All atomicity reasoning is local: `BEGIN IMMEDIATE` transactions
  guarantee the atomic `jobs` claim and the combined
  `telegram_updates → jobs → offset` advance (HLD §6.1, §6.2).
- A single-writer model is enforced at the process level (one Bun
  service); WAL permits concurrent readers.
- Crash safety becomes a single-machine concern, verified by SP-01.
- Backup strategy is limited to that one file plus WAL/SHM siblings
  (Runbook §10).

## Risks and mitigations

| Risk                                                         | Mitigation                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------- |
| WAL surprises with concurrent writers                        | Single-writer process; SP-01 verifies `BEGIN IMMEDIATE`.        |
| Disk corruption / filesystem errors                          | Runbook §10 backup pattern; `/doctor` `sqlite_open_wal` check.  |
| DB grows past disk budget                                    | Retention classes (PRD §12.8.2); `/doctor disk_free_ok` check.  |

## Review trigger

Revisit if we go multi-host, multi-writer, or exceed the capacity
that a single SQLite file on CX22 can serve.

## Refs

- PRD §12.7, Appendix D, AC19.
- HLD §3.1, §5, §6.
- SP-01 in `docs/03_RISK_SPIKES.md`.
