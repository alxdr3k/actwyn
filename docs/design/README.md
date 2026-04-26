# Design Notes

Design docs in this directory capture exploration, alternatives, and
historical reasoning. They are **not** the source of truth for
implemented behavior.

When you need:

- The **current** implementation shape — read `docs/ARCHITECTURE.md`,
  `docs/CODE_MAP.md`, `docs/DATA_MODEL.md`, and `docs/RUNTIME.md`.
- The **why** behind an architecture-level decision — read the
  matching ADR in `docs/adr/`.
- A tactical or policy decision — read the entry in
  `docs/08_DECISION_REGISTER.md`.
- An open question — read the entry in
  `docs/07_QUESTIONS_REGISTER.md`.
- The **acceptance contract** for the P0 vertical — read
  `docs/06_ACCEPTANCE_TESTS.md` plus `docs/PRD.md` §17.

Documents under `docs/design/archive/` are archived design records;
treat them as history, not authority. Before using an archived
design doc as the basis for an implementation change, verify that
the current code, the relevant ADR, and the current-state docs
agree with it.
