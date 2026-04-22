# ADR-0008 — Durable Telegram Inbound / Outbound Ledgers

- Status: accepted
- Date: 2026-04-22
- Supersedes: —
- Superseded by: —

## Context

Telegram's `getUpdates` advances the server-side read cursor when
`offset` exceeds a given `update_id`. If our runtime acknowledges an
update (by advancing offset) before the inbound row has been
persisted, a crash between acknowledgment and persistence loses
that update permanently.

Similarly, outbound `sendMessage` is at-least-once from the
client's perspective: duplicates can occur around crashes and
retries. We cannot prove duplicate-free delivery, but we can prove
duplicate-reduced delivery and make every attempt observable.

## Decision

Store every inbound update in `telegram_updates` **before** advancing
`telegram_next_offset`, and store every outbound intent in
`outbound_notifications` **before** calling `sendMessage`. Both
tables are append-only ledgers with explicit state machines; their
lifecycle is owned by dedicated modules (HLD §4).

Invariants:

1. `telegram_next_offset` advances only in the same transaction that
   persisted the corresponding `telegram_updates` rows (and any
   derived `jobs` rows). See HLD §6.1, §7.1, §9.5.
2. `telegram_updates.update_id` is unique; replayed updates from
   retries do not create duplicate rows (AC05).
3. `outbound_notifications` rows are created with a deterministic
   `payload_hash`. The triple `(job_id, notification_type,
   payload_hash)` deduplicates retried inserts.
4. `outbound_notifications.status = sent` is terminal.
5. `storage_sync` and `notification_retry` failures never roll
   back `provider_run` success (HLD §6.2, §12.4, AC12).

## Alternatives considered

- **In-memory queue for inbound**, persist only on completion —
  loses updates on crash.
- **Fire-and-forget `sendMessage`** — no way to observe which
  messages reached the user, no basis for retry.
- **Webhook instead of long-poll** (see ADR-0002) — different shape,
  same ledger requirement, plus TLS/ops overhead.

## Consequences

- HLD §6.1 (inbound state machine) and §6.3 (outbound state
  machine) are fully specified.
- SP-03 exercises crash points around the inbound ledger and offset
  advance.
- AC05, AC06, AC08 all rely on the ledger semantics.
- Delivery is at-least-once by design; callers tolerate rare
  duplicates and minimize them via `payload_hash`.

## Risks and mitigations

| Risk                                                         | Mitigation                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| Offset advances before row commit                            | HLD §9.5 invariant; SP-03 reproduces crash points.            |
| Duplicate outbound messages                                  | Deduplication triple + terminal `sent`; documented at-least-once semantics. |
| Telegram outage causes backlog in `outbound_notifications`   | `notification_retry` loop; `/status` surfaces pending count.  |

## Review trigger

Revisit if we move to webhook delivery (ADR-0002), if we add a
second chat-level identifier beyond `update_id` for idempotency,
or if Telegram changes offset semantics.

## Refs

- PRD §13, AC05, AC06, AC08.
- HLD §6.1, §6.3, §7.1, §9.
- SP-02, SP-03 in `docs/03_RISK_SPIKES.md`.
- ADR-0002 (long polling).
