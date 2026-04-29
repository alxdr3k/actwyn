# ADR-0017 — Judgment-centered memory convergence for MVP

- Status: accepted
- Date: 2026-04-29
- Relates to: ADR-0006, ADR-0009, ADR-0011, ADR-0012, ADR-0013,
  DEC-039, Q-027, Q-064

## Context

ADR-0006 introduced explicit memory promotion through `memory_items`.
ADR-0009 then added a separate Judgment layer with `judgment_items`,
evidence links, lifecycle state, authority/source separation, and
projection-oriented reads.

The current implementation still has two context-visible long-term
knowledge paths:

- `memory_items.status = 'active'`, written from summaries/corrections and
  injected as memory.
- `judgment_items.lifecycle_status = 'active'` and
  `activation_state = 'eligible'`, committed through the Judgment review path
  and injected as judgments.

That split was useful to land the Judgment substrate without breaking the P0
memory path. It is no longer the right long-term shape for MVP. Both paths can
carry facts, preferences, decisions, cautions, and current-state-like
knowledge. If both remain independently authoritative, the agent can receive
duplicated or conflicting behavioral baselines, with unclear precedence.

The sharper distinction is not "memory table vs judgment table". It is:

- observations, summaries, extracted notes, and candidates; versus
- source-grounded, lifecycle-managed, authority-bearing behavioral baselines.

Q-027 asked whether `memory_items` and `judgment_items` should stay separate,
be migrated in stages, or be unified. The MVP stage is early enough that
preserving a long dual-track behavioral baseline would create more debt than
it avoids.

## Decision

1. The durable behavioral baseline converges on the Judgment System.
   Context-visible long-term facts, preferences, decisions, cautions,
   current state, and procedures that should affect future behavior must be
   represented as `judgment_items` before they are treated as authoritative.

2. `memory_items` remains a memory-plane artifact, not the authority plane for
   behavior. It may continue to store summary byproducts, user-stated notes,
   correction history, compatibility rows, and candidate material, but it must
   not remain an independent source of authoritative behavioral baseline.

3. Physical single-table unification is not required for MVP. The chosen
   convergence is semantic and runtime-facing: authority, evidence, lifecycle,
   activation, retirement, and context priority live in the Judgment layer.

4. Summary extraction must stop promoting durable behavioral candidates
   directly into an active baseline. Durable candidates should either remain
   non-authoritative memory/candidate material or enter the Judgment proposal
   flow. They become active context only after the Judgment approval/evidence/
   commit rules pass.

5. The Context Compiler should treat active/eligible judgments as the
   authoritative behavioral baseline. `memory_items` may still be read for
   non-authoritative recall if an implementation explicitly preserves that
   surface, but it must be lower-priority and clearly separated from baseline
   judgments.

6. This ADR resolves Q-027 in favor of judgment-centered convergence. It also
   resolves Q-064 directionally: the old `mayPromoteToLongTerm` gate must be
   split by meaning, at minimum into persistence-as-memory versus
   behavior-baseline/judgment eligibility.

## Alternatives considered

- **Permanent separation**: rejected for the behavioral baseline. It keeps
  two active long-term knowledge systems with overlapping kinds and ambiguous
  conflict resolution.
- **Immediate physical table merge**: rejected for MVP. It would mix summary
  memory, correction history, evidence-backed judgments, and projections before
  the runtime authority boundary is clean.
- **Long staged migration / soak period**: rejected as the default MVP path.
  With limited production data and an explicit refactor window, preserving
  both baselines longer increases drift.
- **Keep `memory_items` as active baseline and make judgments advisory**:
  rejected. It bypasses the evidence, authority, lifecycle, and retirement
  semantics that the Judgment System was introduced to provide.

## Consequences

- The next implementation track should refactor memory promotion and context
  injection toward Judgment authority, not add more behavior to
  `memory_items.status = 'active'`.
- `src/memory/provenance.ts` should split the current gate semantics so "can
  be persisted as memory/candidate" is not conflated with "can become
  behavior baseline".
- `src/memory/summary.ts` and related tests should stop treating extracted
  facts/decisions/open tasks/cautions from arbitrary provenance as
  automatically authoritative.
- `src/context/compiler.ts` should make Judgment the source of truth for
  behavioral baselines. Any retained memory slot should be non-authoritative
  recall, not a peer authority channel.
- Schema removal or data migration of `memory_items` is a later choice. This
  ADR does not require dropping the table in the first implementation PR.
- Thin current-state docs must continue to distinguish implemented runtime
  behavior from this architectural commitment until the refactor lands.

## Risks and mitigations

- **Loss of useful summary recall**: keep summaries and candidate memory as
  non-authoritative recall, or expose them through explicit query surfaces,
  while moving behavior-changing baselines through Judgment.
- **Too much review friction**: keep proposal/review commands lightweight and
  allow user-confirmed commit flows for MVP. Do not add provider tool
  registration just to compensate for the refactor.
- **Under-specified migration of existing rows**: MVP implementation may leave
  old rows in place as compatibility/candidate data. Any destructive migration
  needs a separate migration plan and tests.
- **Terminology confusion**: docs should use "memory plane" for summaries,
  notes, and candidates; "judgment plane" for authoritative behavioral
  baselines.

## Review trigger

- First implementation PR that changes summary promotion, `memory_items`
  active injection, or Context Compiler baseline priority.
- Production data accumulates enough `memory_items` rows that a migration plan
  becomes necessary.
- A use case requires memory-only active behavioral baselines that cannot be
  represented as Judgment proposals or committed judgments.

## Refs

- Q-027 — `memory_items` / `judgment_items` relationship.
- Q-064 — split `mayPromoteToLongTerm` gate semantics.
- DEC-039 — MVP implementation posture for this ADR.
- ADR-0006 — Explicit memory and attachment promotion.
- ADR-0009 — DB-native, AI-first Judgment System.
- ADR-0012 — Origin/Authority separation and Metacognitive Critique Loop.
- `docs/design/salvage-audit-2026-04.md` §7.
