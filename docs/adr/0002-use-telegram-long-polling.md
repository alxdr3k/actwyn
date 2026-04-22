# ADR-0002 — Use Telegram Long Polling, Not Webhooks

- Status: accepted
- Date: 2026-04-22 (codified from pre-project decision)
- Supersedes: —
- Superseded by: —

## Context

The P0 runtime receives inbound messages from one Telegram bot for
one authorized user on a single Hetzner CX22 host. Telegram offers
two delivery modes: webhooks (HTTP POST to a public endpoint) and
long polling (`getUpdates` with a timeout).

Webhooks require a public HTTPS endpoint, a reverse proxy, and TLS
certificate management. Long polling requires only an outbound HTTP
client.

## Decision

Use **`getUpdates` long polling**, called via direct `fetch` with
`allowed_updates=["message"]`. No bot framework dependency. Offset
durability is the key correctness property (ADR-0008).

## Alternatives considered

- **Webhook + nginx + certbot** — adds a public attack surface,
  extra ops surface for TLS renewal, and a reverse proxy to keep
  running. Buys nothing for a single-user P0.
- **Bot framework** (e.g. `grammy`, `telegraf`) — pulls in a
  medium-sized dependency tree and an abstraction layer between us
  and the API shape we need to reason about for offset durability.
  Rejected per PRD §9.4 dependency policy.

## Consequences

- No TLS or reverse proxy on the host; the only inbound socket is
  SSH.
- Offset durability becomes the critical invariant: HLD §6.1 +
  §9.5, spike SP-03, AC05.
- Outbound delivery (`sendMessage`) is also direct `fetch`; we
  handle Telegram's `retry_after` and 4096-character limits
  ourselves (PRD §8.4).

## Risks and mitigations

| Risk                                                         | Mitigation                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| Long-polling keeps an outbound TCP connection open           | Poll timeout 25–30s; reconnect is cheap on a single-user bot. |
| Direct-fetch edge cases in Telegram API responses            | SP-02 exercises `getUpdates`, `sendMessage`, `getFile`, `429`. |
| Telegram API behavior change                                 | SP-02 re-run on API policy change per `docs/03_RISK_SPIKES.md`. |

## Review trigger

Revisit if we move to multi-user, if we add group-chat support, or
if we migrate off a single-host deployment. Webhook semantics
differ enough that any of those changes reopens this decision.

## Refs

- PRD §13.1, §8.2, AC17.
- HLD §9.1, §9.4, §9.5.
- SP-02 in `docs/03_RISK_SPIKES.md`.
- ADR-0008 (durable inbound / outbound ledgers).
