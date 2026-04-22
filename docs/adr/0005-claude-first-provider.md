# ADR-0005 — Ship Claude as the Only P0 Provider

- Status: accepted
- Date: 2026-04-22 (codified from pre-project decision)
- Supersedes: —
- Superseded by: —

## Context

The PRD long-term vision names several AI providers (Claude, Gemini,
Codex, Ollama). Implementing and testing all of them in P0 would
multiply the provider adapter surface, spike burden (SP-04, SP-05,
SP-06 all re-scoped per provider), and acceptance-test matrix — for
a single-user MVP whose success metric is 7-day dogfood (Q-001).

## Decision

Ship exactly one working provider adapter — **Claude Code CLI** — in
P0. Other providers (`gemini`, `codex`, `ollama`) exist only as
**interface placeholders** so that the adapter contract
(`AgentRequest` / `AgentResponse`) is enforced but not implemented.

Claude runs under two profiles (HLD §8.1):

- **Conversational** — the default path for inbound chat runs.
- **Advisory / lockdown** — used by summary generation under
  `--tools ""` and `--permission-mode dontAsk` (ADR-0007 ties this
  to session-as-cache semantics).

Tools are disabled in both profiles for P0. Any tool enablement is
a PRD change.

## Alternatives considered

- **Multi-provider from day one** — rejected; multiplies spike
  surface and test matrix without P0 value.
- **Claude + one other provider** — same objection, half strength.

## Consequences

- SP-04, SP-05, SP-06 focus only on Claude.
- `/provider` command exists but only `claude` is selectable.
- Adapter interface stays provider-agnostic so P1 can add others.
- All Claude-specific flags and behaviors are documented in HLD §8
  and gated by spike fixtures in `test/fixtures/claude-stream-json/`.

## Risks and mitigations

| Risk                                                | Mitigation                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| Claude CLI changes aggressively mid-P0              | Pinned version; spike re-runs on bump; fixtures checked in.       |
| Claude lockdown incomplete or bypassable            | SP-05 proves lockdown; tools are off in both profiles.            |
| Single-provider dependency concentration            | Adapter contract stays clean; replacement is additive in P1.      |

## Review trigger

Revisit when a second provider becomes required for a P1 user
journey, or when Claude lockdown semantics change in a way that
affects PRD §15 (security).

## Refs

- PRD §5 (non-goals), §11 (provider adapter requirements), AC11.
- HLD §8.
- SP-04, SP-05, SP-06 in `docs/03_RISK_SPIKES.md`.
- ADR-0007 (provider session as cache).
