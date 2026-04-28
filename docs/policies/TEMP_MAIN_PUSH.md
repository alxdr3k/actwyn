# Temporary: Direct main-push policy

> **This file documents a temporary override of the canonical branch policy.**
> When this project graduates to the `feat/* → dev → main` flow, delete this
> file and remove the `push` trigger from `.github/workflows/doc-freshness.yml`.

## Current temporary policy

During the early development phase, direct `git push` to `main` is permitted
without a PR. This keeps iteration fast while the project is in solo-developer
mode with no shared branch surface.

**Canonical policy (target state):** `feat/* → dev → main` via PR, identical
to the standard branch workflow documented in the global `CLAUDE.md`.

## Effect on enforcement mechanisms

Because most changes land via direct push rather than a PR, the PR-based
mechanisms in this repo have limited reach during this period:

| Mechanism | Behaviour during temp policy |
|-----------|------------------------------|
| `.github/pull_request_template.md` | Active only when a PR is opened; implemented now so it is ready when policy graduates |
| `.github/workflows/doc-freshness.yml` | Triggers on both `pull_request` **and** `push` to `main` — the `push` trigger is the active guard during this period |

The `push`-trigger path posts a GitHub Actions summary (not a PR comment)
because there is no PR to comment on. See the workflow for details.

## Graduation checklist

Remove this file and the `push` (main) trigger from the workflow when **all**
of the following are true:

- [ ] The project has a stable `dev` branch and more than one active contributor
      or active PR cadence
- [ ] CI is reliably green on `dev`
- [ ] The global `CLAUDE.md` branch policy has been updated to remove the
      `actwyn` exception

After removing the `push` trigger, the workflow remains useful on PRs alone.
