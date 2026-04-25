# Architecture Decision Records

> Status: living index · Owner: project lead · Last updated: 2026-04-26

This directory holds **architecture-level decisions**: choices that
are hard to reverse, have broad blast radius, or shape the system's
runtime / storage / security posture for a long time.

Smaller, more tactical decisions (policy defaults, command sets,
operational thresholds) live in
[`docs/08_DECISION_REGISTER.md`](../08_DECISION_REGISTER.md) with
`DEC-###` ids.

Questions that have not yet resolved live in
[`docs/07_QUESTIONS_REGISTER.md`](../07_QUESTIONS_REGISTER.md) with
`Q-###` ids.

All links across Q-### ↔ DEC-### ↔ ADR-#### ↔ PRD / HLD / AC live
in [`docs/09_TRACEABILITY_MATRIX.md`](../09_TRACEABILITY_MATRIX.md).

## Promotion rules

Use an ADR when **all** of the following are true:

1. The choice affects architecture (runtime, storage, protocol,
   trust boundary, provider, deployment shape).
2. Reversing it would require rewriting multiple modules or
   migrating durable state.
3. A future engineer reading the PRD/HLD would be unable to infer
   the rationale from the artifact alone.

If a decision fails any of the above, it belongs in the Decision
Register (`DEC-###`), not here.

## Template

```
# ADR-#### — Short title

- Status: proposed | accepted | superseded | deferred
- Date: yyyy-mm-dd
- Supersedes: ADR-#### (optional)
- Superseded by: ADR-#### (optional)

## Context

## Decision

## Alternatives considered

## Consequences

## Risks and mitigations

## Review trigger

## Refs
```

## Index

| ID       | Title                                                     | Status   |
| -------- | --------------------------------------------------------- | -------- |
| ADR-0001 | Use Bun + TypeScript for P0                               | accepted |
| ADR-0002 | Use Telegram long polling, not webhooks                   | accepted |
| ADR-0003 | Use SQLite (WAL) as the active state source of truth      | accepted |
| ADR-0004 | Use S3 as an artifact archive, not an active memory DB    | accepted |
| ADR-0005 | Ship Claude as the only P0 provider; others are stubs     | accepted |
| ADR-0006 | Explicit memory and attachment promotion                  | accepted |
| ADR-0007 | Provider session is a cache; internal session is truth    | accepted |
| ADR-0008 | Durable Telegram inbound / outbound ledgers               | accepted |
| ADR-0009 | DB-native, AI-first Judgment System                       | accepted |
| ADR-0010 | Cognitive extension of Judgment System (goal/workspace/attention/metacognition) | accepted |
