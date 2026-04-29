# ADR-0016 — Capability-governed internal task runner

- Status: accepted
- Date: 2026-04-29
- Relates to: ADR-0005 (Claude provider boundary), ADR-0014 (Bun runtime stack),
  DEC-037 (documentation lifecycle), Q-067

## Context

actwyn's current P0 runtime is a Telegram personal agent. User turns are
queued as `provider_run` jobs and sent to the Claude CLI provider, but that
provider path is intentionally locked down: Claude is invoked with no tools
and `dontAsk` permission mode. It can answer questions, but it cannot safely
clone repositories, edit files, run shell commands, push branches, or deploy.

The accepted hypothesis session asked whether actwyn could notice a problem
while being used, clone the actwyn repo, fix the issue, test it, and prepare a
PR. Follow-up questions generalized the problem: repo work, deploy work,
storage mutation, provider execution, filesystem writes, shell commands, and
future tool registration are all high-risk side effects. They need one
authorization model and real execution enforcement, not scattered ad hoc
checks.

External GitHub Actions / hosted runners were rejected for this use case due
to dependency and orchestration overhead. The preferred direction is internal
execution, but forked child processes alone are not a security boundary because
they inherit the service user's filesystem, network, secret, and database
access.

## Decision

1. Future repo / deploy automation will use a **capability-governed internal
   task runner**, not the existing `provider_run` path.

2. High-risk workflows live under domain task modules:
   - `src/tasks/repo/*` for repository investigation, edits, tests, branch /
     PR preparation.
   - `src/tasks/deploy/*` for future deployment / restart workflows.

   `src/queue/*` remains responsible for job claim / dispatch mechanics. Task
   modules own domain workflow only.

3. `src/security/*` is the policy and audit boundary. It owns capability
   request / decision / approval / audit records. It does not execute shell,
   git, filesystem, network, provider, storage, or deployment actions.

4. `src/execution/*` is the policy-enforcement boundary for dangerous
   process actions. Shell / git / filesystem / network / coding-agent
   execution must require an approved capability token and enforce the
   decision at the actual spawn / filesystem / network boundary.

5. The default policy is deny. A capability decision may grant a bounded
   operation with constraints such as workspace path, allowed argv prefixes,
   network mode, branch pattern, timeout, output limit, environment allowlist,
   and expiration.

6. Internal execution requires OS sandboxing. Fork alone is insufficient.
   Baseline adapters:
   - macOS development: `sandbox-exec` where available.
   - Ubuntu production: `bubblewrap` baseline.
   - Defense-in-depth candidates: Landlock for filesystem / network
     restrictions where supported, plus cgroup / systemd resource limits for
     CPU, memory, process count, file size, and wall-clock timeout.

   If the required sandbox adapter is unavailable or cannot apply the policy,
   repo / deploy tasks fail closed.

7. Repo tasks are phase-separated because each phase needs different
   capabilities:
   - clone / fetch: network allowed, git-only command allowlist.
   - install: explicit dependency-install capability, bounded command set.
   - agent edit: network denied, write access limited to the task workspace.
   - verify: network denied by default, bounded test commands.
   - push / PR: separate human approval, network allowed only for Git / GitHub
     operations.

8. The first repo-task implementation scope is branch / diff / draft PR
   preparation. Merge, production deploy, service restart, destructive DB
   mutation, S3 delete, and secret access require separate high / critical
   capabilities and explicit human approval.

9. Repo / deploy task sandboxes must not mount the live actwyn working tree for
   mutation, the live SQLite database, `/etc/actwyn/env`, memory / object
   stores, host SSH agents, GitHub credential stores, Docker sockets, or other
   ambient host control sockets.

10. The current provider runtime remains locked down. This ADR does not
    register tools for `provider_run`, does not grant Claude broad shell /
    filesystem rights, and does not implement self-modifying runtime behavior.

## Alternatives considered

- **Use the existing `provider_run` path**: rejected. It would mix normal chat
  with high-risk filesystem / shell / git privileges and weaken the current
  provider boundary.
- **External GitHub Actions / hosted runner execution**: rejected for this
  track due to external dependency and workflow overhead, though it remains a
  possible future integration target.
- **Forked child process without OS sandbox**: rejected. It inherits the same
  service-user access to secrets, DB, objects, memory paths, and network.
- **Docker / VM / gVisor as the first implementation**: deferred. Stronger
  isolation may be useful later, but the initial target is a lightweight
  process sandbox.
- **nsjail as the first implementation**: deferred. It has stronger integrated
  controls, but a larger configuration surface than needed for the first
  actwyn runner.
- **Repo-specific implementation only**: rejected. Repo work is the first user,
  but the underlying problem is capability-governed side-effect control.
- **Single "security god module"**: rejected. Security decides and audits;
  execution modules enforce; task modules orchestrate.

## Consequences

- Future implementation should introduce `src/security/*`, `src/execution/*`,
  and `src/tasks/repo/*` together with tests that prove deny-by-default,
  approval gating, sandbox policy application, command allowlisting, and
  fail-closed behavior.
- Future `src/tasks/deploy/*` work must reuse the same capability and execution
  boundaries instead of inventing a deploy-specific security model.
- Runtime docs, code map, testing docs, operations docs, and acceptance criteria
  must be updated when implementation begins.
- `/doctor` or task preflight should eventually report sandbox adapter
  availability and explain why repo / deploy tasks are disabled.
- This ADR is a future architecture commitment only; it does not change the
  current P0 runtime.

## Risks and mitigations

- **Sandbox escape or misconfiguration**: keep policies minimal, bind only the
  workspace, deny network by default, avoid host control sockets, add tests for
  prohibited paths, and fail closed when the adapter cannot enforce a rule.
- **Confused deputy through ambient credentials**: do not pass service secrets,
  SSH agents, GitHub credentials, live DB paths, or host config into the
  sandbox. Bind capabilities to actor, job, operation, resource, reason, and
  expiration.
- **Over-generalized security framework**: start with repo tasks as the first
  concrete user. Add abstractions only where repo / deploy workflows share a
  real side-effect boundary.
- **Human approval fatigue**: classify capabilities by risk and require
  approval only for high / critical actions such as push, PR creation, deploy,
  restart, secret access, destructive mutation, or production writes.
- **Local macOS and Ubuntu production drift**: keep sandbox adapters behind the
  same `src/execution` contract and test each adapter's observable behavior,
  not its internal flags.

## Review trigger

- First implementation PR for `src/tasks/repo/*`, `src/security/*`, or
  `src/execution/*`.
- Need to execute deploy / restart / destructive storage or DB tasks.
- A sandbox adapter is unavailable on the production Ubuntu host.
- A sandbox / capability audit finds an enforcement bypass.
- External hosted runner overhead becomes acceptable or required by policy.

## Refs

- Q-067 — actwyn self-improvement task 실행 경계.
- Saltzer and Schroeder, "The Protection of Information in Computer Systems"
  (least privilege, fail-safe defaults, complete mediation):
  https://www.mit.edu/~Saltzer/publications/protection/Basic.html
- Norm Hardy, "The Confused Deputy":
  https://www.cs.umd.edu/~jkatz/security/downloads/capabilities.html
- "Capability Myths Demolished":
  https://papers.agoric.com/papers/capability-myths-demolished/abstract/
- OPA docs, policy decision / enforcement separation:
  https://www.openpolicyagent.org/docs
- Google Zanzibar authorization paper:
  https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/
- Linux Landlock documentation:
  https://docs.kernel.org/userspace-api/landlock.html
- bubblewrap README:
  https://github.com/containers/bubblewrap/blob/main/README.md
- Claude Code sandboxing docs:
  https://code.claude.com/docs/en/sandboxing
