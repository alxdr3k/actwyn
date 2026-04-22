# ADR-0001 — Use Bun + TypeScript for P0

- Status: accepted
- Date: 2026-04-22 (codified from pre-project decision)
- Supersedes: —
- Superseded by: —

## Context

The Personal Agent P0 is a single-host, single-user Telegram runtime
that spawns a Claude CLI subprocess, persists state in SQLite, and
mirrors artifacts to an S3-compatible bucket. We need a runtime that
provides, out of the box:

- Native `fetch` for direct Telegram Bot API calls (no bot framework).
- A built-in SQLite binding that supports WAL mode.
- An S3 client capable of talking to Hetzner Object Storage.
- `spawn` with detached-process-group semantics for subprocess
  lifecycle control.
- First-class TypeScript without a separate build toolchain.

We also want minimal supply-chain surface: the PRD (§9.4) targets a
near-zero external-dependency build.

## Decision

Use **Bun** (exact version pinned per PRD Appendix F) with
**TypeScript** for all P0 code. Node.js is not used at runtime. Only
Bun-native primitives (`bun:sqlite`, `Bun.spawn`, `Bun.S3Client`) are
used for the P0 critical path. `@aws-sdk/client-s3` is pre-authorized
as a **fallback** storage driver if SP-08 reveals blocking Hetzner
incompatibilities, but is not a P0 default dependency (DEC-010).

## Alternatives considered

- **Node.js** with `better-sqlite3` + `@aws-sdk/client-s3` — more
  mature ecosystem, but larger dependency tree and slower to reach
  the feature set we need (built-in S3 client, typed runtime).
- **Deno** — less mature SQLite + S3 story at the time of decision;
  subprocess story requires more glue.
- **Go** — excellent runtime; forfeits TypeScript ecosystem and
  forces us to reimplement Claude stream-json parser fixtures we
  want to keep close to the rest of the code.

## Consequences

- Single runtime across dev, test, and prod; the dev loop matches
  production closely.
- `bun:sqlite`, `Bun.S3Client`, and `Bun.spawn` each become critical
  dependencies and are covered by spikes SP-01, SP-08, and SP-07.
- We pin Bun to an exact patch version; upgrades are governed by the
  spike re-run triggers (`docs/03_RISK_SPIKES.md`).

## Risks and mitigations

| Risk                                                 | Mitigation                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| Bun surprise in `bun:sqlite` WAL or atomic claim     | SP-01 must pass before Phase 4 begins.                             |
| `Bun.S3Client` quirks against Hetzner                | SP-08 verifies path-style; DEC-010 documents the AWS SDK fallback. |
| `Bun.spawn` detached semantics change across kernels | SP-07 is re-run on Bun bumps and kernel major bumps.               |

## Review trigger

Revisit if Bun introduces a blocking regression we cannot pin
around, or if any of SP-01 / SP-07 / SP-08 returns a verdict we
cannot work around at P0 scope.

## Refs

- PRD §Appendix F (version pin), §9.4 (dependency policy).
- SP-01, SP-07, SP-08 in `docs/03_RISK_SPIKES.md`.
- Q-??? in `docs/07_QUESTIONS_REGISTER.md` (runtime choice — decided
  pre-project, recorded here for audit).
