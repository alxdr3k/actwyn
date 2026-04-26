# actwyn docs

Index of every doc in this directory. Skim this first; jump to the
specific file you need.

## When you need …

| Need                                                                   | Read                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| Current architecture (what is implemented)                             | [`ARCHITECTURE.md`](./ARCHITECTURE.md)                       |
| Where code lives                                                       | [`CODE_MAP.md`](./CODE_MAP.md)                               |
| Database / schema                                                      | [`DATA_MODEL.md`](./DATA_MODEL.md)                           |
| Runtime flow (boot, inbound, jobs, outbound)                           | [`RUNTIME.md`](./RUNTIME.md)                                 |
| Tests and validation commands                                          | [`TESTING.md`](./TESTING.md)                                 |
| Local operations / deploy / env                                        | [`OPERATIONS.md`](./OPERATIONS.md)                           |
| Architecture decisions                                                 | [`adr/`](./adr/) (start at [`adr/README.md`](./adr/README.md)) |
| Tactical / policy decisions                                            | [`08_DECISION_REGISTER.md`](./08_DECISION_REGISTER.md)       |
| Open questions                                                         | [`07_QUESTIONS_REGISTER.md`](./07_QUESTIONS_REGISTER.md)     |
| Q ↔ DEC ↔ ADR ↔ AC traceability                                        | [`09_TRACEABILITY_MATRIX.md`](./09_TRACEABILITY_MATRIX.md)   |
| Documentation policy                                                   | [`DOCUMENTATION.md`](./DOCUMENTATION.md)                     |
| Judgment System Phase 0 / 0.5 design (historical record per DEC-037)   | [`JUDGMENT_SYSTEM.md`](./JUDGMENT_SYSTEM.md)                 |
| Historical design notes                                                | [`design/`](./design/)                                       |
| Generated docs (placeholder)                                           | [`generated/`](./generated/)                                 |
| AI coding agent guidance                                               | [`/AGENTS.md`](../AGENTS.md)                                 |

## Long P0 design and acceptance docs

These are historical reasoning and the P0 acceptance contract.
Don't load them by default; open them when a task explicitly
needs the *why* or the acceptance criterion.

| File                                                              | Purpose                                          |
| ----------------------------------------------------------------- | ------------------------------------------------ |
| [`PRD.md`](./PRD.md)                                              | Personal Agent Product Requirements (P0).        |
| [`00_PROJECT_DELIVERY_PLAYBOOK.md`](./00_PROJECT_DELIVERY_PLAYBOOK.md) | How the P0 project is delivered.             |
| [`02_HLD.md`](./02_HLD.md)                                        | High-Level Design — module boundaries, state machines, invariants. |
| [`03_RISK_SPIKES.md`](./03_RISK_SPIKES.md)                        | Risk spikes (SP-##).                             |
| [`04_IMPLEMENTATION_PLAN.md`](./04_IMPLEMENTATION_PLAN.md)        | P0 implementation plan.                          |
| [`05_RUNBOOK.md`](./05_RUNBOOK.md)                                | Operational runbook (P0).                        |
| [`06_ACCEPTANCE_TESTS.md`](./06_ACCEPTANCE_TESTS.md)              | P0 acceptance criteria + test plan.              |

## Source-of-truth hierarchy

1. Code, tests, migrations
2. Generated docs / schemas produced from those sources
3. Thin current-state docs (top of this index)
4. ADRs (`adr/`)
5. Q / DEC registers + traceability matrix
6. Long design / historical / archived docs

See [`DOCUMENTATION.md`](./DOCUMENTATION.md) for the full policy
and the "what to update when" table.
