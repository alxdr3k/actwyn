# Archived Design Docs

Archived design docs are historical records. They explain why a
direction was considered, what alternatives were evaluated, and what
intermediate shape an architecture passed through before reaching
the current implementation.

They are **not** authoritative for current runtime behavior.

Before using an archived design doc as the basis for an
implementation change, verify in this order:

1. `docs/ARCHITECTURE.md` — does the doc still describe the current
   implementation status?
2. The relevant ADR(s) in `docs/adr/` — has the architecture been
   superseded?
3. The current code, tests, and migrations — does the implementation
   actually match the doc?

If any of those disagree with the archived doc, the archived doc is
outdated. Open a new ADR (or a small patch to the current-state docs)
rather than editing the archived doc to match.

## What goes here

- Long Phase 0 / 0.5 design records once they are clearly superseded
  by accepted ADRs and shipped migrations.
- Spike write-ups whose recommendations have been absorbed into the
  PRD / HLD or into ADRs.
- Earlier drafts of design directions that were not pursued.

## What does **not** go here

- Documents that are still actively shaping decisions — those stay
  in `docs/` (top-level) until they are clearly historical.
- ADRs — those live in `docs/adr/` regardless of status; superseded
  ADRs stay in place and are linked from their replacement.
- The PRD, HLD, Playbook, Risk Spikes, Implementation Plan, Runbook,
  and Acceptance Tests — these remain in `docs/` as the P0
  acceptance and design record.

## Archival procedure

When archiving a design doc:

1. Add a new ADR (or update an existing one) that captures the
   accepted decision.
2. Confirm all inbound links to the doc have been redirected to the
   ADR or to a current-state doc.
3. Move the file under `docs/design/archive/` in a single commit.
4. Add a row to this README listing the archived file and the ADR
   that supersedes it.

## Archived files

(none yet — this directory is a placeholder)
