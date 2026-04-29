<!--
Keep PR descriptions short. The reviewer's first job is the diff;
this template is a checklist, not a place for long prose.
-->

## Summary

<!-- 1–3 bullets describing what changed and why. -->

## Documentation impact

- [ ] No doc impact
- [ ] Updated roadmap / status ledger (`docs/04_IMPLEMENTATION_PLAN.md`)
- [ ] Updated compressed current state (`docs/context/current-state.md`)
- [ ] Updated acceptance gates (`docs/06_ACCEPTANCE_TESTS.md`)
- [ ] Updated current-state docs:
  - [ ] `docs/ARCHITECTURE.md`
  - [ ] `docs/CODE_MAP.md`
  - [ ] `docs/DATA_MODEL.md`
  - [ ] `docs/RUNTIME.md`
  - [ ] `docs/TESTING.md`
  - [ ] `docs/OPERATIONS.md`
- [ ] Thin current-state docs were updated by replacing stale current state,
      not by appending implementation history
- [ ] Detailed implementation history stays in PRs, tests, ADRs, generated
      docs, issues, or commits
- [ ] Added or superseded an ADR under `docs/adr/`
- [ ] Updated registers (`docs/07_QUESTIONS_REGISTER.md` /
      `docs/08_DECISION_REGISTER.md` /
      `docs/09_TRACEABILITY_MATRIX.md`)
- [ ] Regenerated `docs/generated/*` (`bun run docs:generate:schema`) and
      committed the output
- [ ] Updated SHA header (`Last verified against code: <SHA> (<date>)`) on any
      thin doc whose subject area this PR touches
- [ ] Updated CI/CD docs or workflow files/examples (`docs/11_CI_CD.md`,
      `.github/workflows/*.yml*`)
- [ ] Archived or superseded an old design note
      (`docs/design/archive/`)

See [`docs/DOCUMENTATION.md`](../docs/DOCUMENTATION.md) for the
"what to update when" rules.

## Validation

- [ ] `bun run ci` passed locally (`lint:redactor` + `lint:thin-docs` + `typecheck` + `bun test`)
- [ ] If schema changed: bumped `expected_schema_version` in `src/main.ts`
- [ ] CI/CD impact checked
- [ ] Verified the PR does not touch unrelated runtime code

<!--
If you cannot run validation locally (no Bun, no network, etc.),
say so explicitly here rather than leaving the checkboxes ticked.
-->
