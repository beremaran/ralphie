# Safety model

This page is for operators before they run Ralphie against a repository and for
contributors changing mutation paths. It is the authoritative reference for
Git/GitHub mutation boundaries, remote invariants, and workspace risks. Return
to the [documentation index](README.md) for the full
reading map.

> [!CAUTION]
> Ralphie commits approved work and pushes directly to the branch selected by
> `repos."owner/repo".branch` (default `main`, otherwise `master`). Test against a disposable repository before enabling mutations.

## Delivery guardrails

Delivery automation deserves explicit guardrails. Before agent work and again
before a push, Ralphie verifies that:

- the checkout and `origin` match the requested GitHub repository;
- the local checkout is still on the selected branch and expected commit;
- the remote branch has not moved from the captured base;
- the result is exactly the expected local commit; and
- the push is non-force.

If any invariant fails, Ralphie halts instead of guessing or retrying a
dangerous operation.

Delivery is one deterministic operation: it creates exactly one commit from the
allowed staged tree, re-checks the local branch/head and the remote base
immediately before the push, and pushes only with Git's non-force mode. A push
response is not proof; an authoritative remote branch read establishes whether
the commit arrived, including reconciliation of a lost push response. Movement
detected before staging/commit prevents the commit from being created; movement
detected before or during delivery is never followed, reset over, or
force-pushed over. Cancellation is checked at every mutation boundary, the push
is attempted at most once, and failures and cancellations leave a clean,
recoverable checkout.

Implementation agents may use normal shell composition, pipes, redirection,
and language runtimes. Ralphie's shell hook rejects explicit agent requests for
orchestration-owned Git/GitHub mutations such as commits, pushes, branch
changes, resets, cleans, and `gh` calls. This hook is a guardrail, not a
security sandbox: deterministic repository invariants and the isolated
delivery services remain authoritative.

## Workspace risk

There is one intentionally destructive local behavior: when reusing an existing
repository checkout that is not clean, Ralphie runs the equivalent of `git reset
--hard` and `git clean -fd`, then aligns it with the selected remote branch.
Tracked modifications and untracked, non-ignored files inside that checkout are
discarded. Keep unrelated work outside Ralphie's workspace.

The workspace's `.ralphie` directory contains only repository checkouts and
Ralphie's run state, events, and recovery artifacts. Harness credentials and
settings belong to each harness CLI and are never written under this path;
keep provider configuration outside the workspace.

Ralphie removes the entire workspace recursively before preparing a run and
again after a successful run, after protected-path checks. The retained
workspace after a failure is
[documented with cleanup and recovery](operations-and-recovery.md#cleanup). Use
a path dedicated to Ralphie:

```bash
bunx @beremaran/ralphie owner/repository \
  --set workspace=/tmp/ralphie
```

## Agent and mutation boundaries

Agent sessions run as headless harness CLI invocations rooted at the
repository checkout. Read-only roles run in the harness's read-only mode
(Claude Code plan mode with a read-only tool list); the `implementer` and
`fixer` run in the harness's `safe` mode and may edit the checkout. Post-task
verification fails the task when the checkout's branch or head moved anyway.
Structured decisions are returned as a result validated against the canonical
Zod schema (natively where the harness supports it, otherwise from a final
JSON block, with a bounded number of corrections), and the validated value is
what the domain boundary accepts. A repository-backed blocker is an optional
`needsAttention` field in that result, not a mutation-capable tool. Ralphie
stages, verifies, commits, pushes, and mutates
GitHub through deterministic domain services. Invalid output or a harness failure
becomes a failed issue outcome without proceeding to the next operation.
A turn that produces no assistant message fails instead of producing a
decision.

Protected maintainer choices are also enforced before verification: a staged
change that selects a project license fails closed unless that exact license
is authorized by the issue text, deferring to a maintainer decision instead of
silently establishing policy.

Verification is opt-in: Ralphie runs only the commands listed under
`repos."owner/repo".verify`, and when none are listed the gate is skipped and review
proceeds on the staged diff. Configured commands run against the staged tree
and their evidence is
bound to that tree before review or commit. A non-zero command exit is treated
as actionable implementation feedback: a fresh fix session receives bounded
failure evidence, and Ralphie restages and retries up to five times.
Staged-tree mutation and exhausted repair remain
hard safety stops. The direct-push path never uses force. See
[Workflows](workflows.md) for the complete implementation and delivery sequence,
and [Operations and recovery](operations-and-recovery.md) for what remains
available after a safety stop.

## Approval modes

Read-only roles never edit and ignore the approval mode. The editing roles
(`implementer` and `fixer`) run under `approval`, set at the top level of the
configuration and overridable per repository and per harness
(`harnesses.<name>.approval`):

- `safe` (default) uses the harness's own approval or sandbox: Claude Code
  auto mode, or the Codex workspace-write sandbox.
- `yolo` turns off every approval and sandbox check (Claude Code
  `bypassPermissions`, Codex `--dangerously-bypass-approvals-and-sandbox`, and
  the only mode pi and OpenCode have). Use it only in an environment that is
  already isolated.

Before any work starts, Ralphie checks that every assigned harness starts,
that `safe` is actually granted where configured (Claude Code can silently
fall back from auto mode), and that no editing role runs on pi or OpenCode
without `yolo`, because neither has a sandbox or approval system. A failure
stops the run within seconds and names the configuration change that fixes it,
such as `harnesses.pi.approval: yolo` or moving the role with
`roles.implementer`. If `limits.maxBudgetUsd` is set, startup also warns about
each assigned harness that cannot enforce a spend cap; only Claude Code does.

Each session also has a wall-clock limit (`limits.sessionTimeoutMinutes`: 60
minutes for editing roles, 15 for read-only roles). Exceeding it kills the
session's whole process group, so tools the harness started die with it, and
counts as a failed attempt.

## Bounded command execution

No command runs unbounded. Every process Ralphie spawns, and every shell
command its implementation agent runs, carries a hard deadline so a hung
process fails loudly instead of stalling an issue run:

- **Agent shell commands** default to a 120-second timeout with a 600-second
  maximum. An omitted `timeout` gets the default; a larger declared timeout is
  clamped to the ceiling so the model cannot disable the guardrail. A timed-out
  command returns to the agent as a tool error with its partial output, and the
  agent may retry with an explicit `timeout` for genuinely slower commands.
- **Ralphie-owned commands** (git and `gh` operations against the repository,
  workspace preparation, authentication checks) default to a 10-minute timeout.
- **Verification commands** (`verify`) run under a 30-minute timeout
  because they execute the repository's full gate; they are the deliberate
  exception to the shorter defaults. When no command is configured, no
  verification process runs.

A timed-out command is killed (including its process tree) and reported as
`CommandTimeoutError` with the deadline and command in the message. These
deadlines are fail-closed bounds, not retry budgets: they turn an indefinitely
stuck session into a recoverable, reported failure.
