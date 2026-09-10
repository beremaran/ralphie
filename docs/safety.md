# Safety model

This page is for operators before they run Ralphie against a repository and for
contributors changing mutation paths. It is the authoritative reference for
Git/GitHub mutation boundaries, remote invariants, dry-run behavior, and
workspace risks. Return to the [documentation index](README.md) for the full
reading map.

> [!CAUTION]
> Ralphie defaults to `lgtm`: it commits approved work and pushes directly to
> the branch selected by `--branch`. Use `--workflow pr` for automatically
> merged feature-branch delivery, or start with the dry-run command below.

## Delivery guardrails

Delivery automation deserves explicit guardrails. For `lgtm` delivery, and for
the feature-branch pushes used by `pr`, Ralphie verifies before agent work and
again before a push that:

- the checkout and `origin` match the requested GitHub repository;
- the local checkout is still on the selected branch and expected commit;
- the remote branch has not moved from the captured base;
- the result is exactly the expected local commit; and
- the push is non-force.

If any invariant fails, Ralphie halts instead of guessing or retrying a
dangerous operation.

For revisions delivered to an existing managed feature branch (the `pr`
workflow), a revision-specific contract applies: the local checkout and the
remote branch must both still sit at the exact expected prior feature head
(the first delivery may use the original PR/base commit as its prior head and
may find the remote branch absent), the feature head must descend from the
original PR/base commit however many commits it is ahead of it, and every push
stays non-force. A stale local head, an externally moved remote head, a
missing remote branch beyond the first delivery, an unanchored feature head,
or a force push halts the revision instead of following or resetting over the
expected head.

Managed feature-branch revisions are delivered as one deterministic
operation that runs those safety checks before staging/commit, creates exactly
one commit from the allowed staged tree, re-checks the local branch/parent and
the remote feature/PR head immediately before the push, and pushes only with
Git's non-force mode to the explicit `HEAD:refs/heads/<branch>` destination
ref. After both a successful push and a push/transport error the operation
reads the authoritative remote branch with `git ls-remote`; it never infers
success from a local tracking ref or from the push command's response alone.
The discriminated, typed outcome tells a coordinator exactly what happened:
`confirmed` when the remote equals the new commit and the checkout is clean
(including a lost push response reconciled to success by the remote read),
`external-movement` when the remote no longer equals the expected prior head
(halt without retrying or overwriting; the created commit is retained), or
`ambiguous` when the remote read cannot prove whether the new commit arrived
(the created clean commit is retained and requires safe reconciliation).
Movement detected before staging/commit prevents the commit from being
created; movement detected before or during delivery is never followed, reset
over, or force-pushed over. Cancellation is checked at every mutation
boundary, the push is attempted at most once, and failures and cancellations
leave a clean, recoverable checkout.

Implementation agents may use normal shell composition, pipes, redirection,
and language runtimes. Ralphie's shell hook rejects explicit agent requests for
orchestration-owned Git/GitHub mutations such as commits, pushes, branch
changes, resets, cleans, and `gh` calls. This hook is a guardrail, not a
security sandbox: deterministic repository invariants and the isolated
delivery services remain authoritative.

In `pr` mode, the feature branch, pull request, review comments, and merge are
reconciled through GitHub before the linked issue is considered complete.

## Workspace risk

There is one intentionally destructive local behavior: when reusing an existing
repository checkout that is not clean, Ralphie runs the equivalent of `git reset
--hard` and `git clean -fd`, then aligns it with the selected remote branch.
Tracked modifications and untracked, non-ignored files inside that checkout are
discarded. Keep unrelated work outside Ralphie's workspace.

The workspace's `.ralphie` directory contains only repository checkouts and
Ralphie's run state, events, and recovery artifacts. Pi credentials and
default-model settings live in `~/.pi/agent` (or `PI_CODING_AGENT_DIR`) and are
never written under this path; keep provider configuration outside the
workspace.

`--clean start` and `--clean end` recursively delete the workspace after
protected-path checks. Their mode-specific dry-run and resume rules are
[documented with cleanup and recovery](operations-and-recovery.md#cleanup). Use a
path dedicated to Ralphie:

```bash
bunx @beremaran/ralphie owner/repository \
  --workspace /tmp/ralphie \
  --clean both
```

## Dry-run validation

For a delivery-mutation-free validation, use:

```bash
bunx @beremaran/ralphie owner/repository --dry-run --max-issues 1
```

Dry-run mode performs real preflight, cloning, issue discovery, and read-only
issue grounding. For actionable issues it performs a read-only complexity
assessment and reports the implementation or decomposition route; it also
reports already-resolved and needs-attention routes with the selected policy
and blocker details. It may change the local workspace during preparation and
persists only run-level state and progress. It reuses matching persisted
routing decisions when available but never writes per-issue complexity or
needs-attention artifacts. Preparation may reset, clean, or switch the local
checkout, but dry-run logic cannot invoke implementation, decomposition
mutation, delivery, commits, pushes, or GitHub mutations. A resumed dry run
remains a dry run.

## Agent and mutation boundaries

Agent sessions are rooted at the repository checkout. Review-profile sessions
expose read-only tools (`read` and the non-mutating shell allowlist) and deny
file writes; implementation sessions may edit the checkout. Every session
enforces a shell denylist that rejects commits, pushes, branch/reset/clean
operations, and `gh` commands before execution, and post-task verification
fails the task when the checkout moved anyway. Structured decisions are
returned as fenced JSON and re-validated at the Ralphie domain boundary; a
repository-backed blocker is an optional fenced `needs-attention` block, not a
mutation-capable tool. Ralphie stages, verifies, commits, pushes, and mutates
GitHub through deterministic domain services. Invalid output or a pi failure
becomes a failed issue outcome without proceeding to the next operation. The
canonical Zod decision schemas are sent to pi as JSON Schema with validation
retries, and the returned value is re-validated at the Ralphie domain boundary.
A turn that produces no assistant message fails instead of producing a
decision.

Protected maintainer choices are also enforced before verification: a staged
change that selects a project license fails closed unless that exact license
is authorized by the issue text, deferring to a maintainer decision instead of
silently establishing policy.

Verification commands are run against the staged tree and their evidence is
bound to that tree before review or commit. A non-zero command exit is treated
as actionable implementation feedback: a fresh fix session receives bounded
failure evidence, and Ralphie restages and retries up to five times. Missing
verification configuration, staged-tree mutation, and exhausted repair remain
hard safety stops. The direct-push path never uses force. See
[Workflows](workflows.md) for the complete implementation and delivery sequence,
and [Operations and recovery](operations-and-recovery.md) for what remains
available after a safety stop.

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
- **Verification commands** (`--verify-command`, or the discovered
  `bun run check`) run under a 30-minute timeout because they execute the
  repository's full gate; they are the deliberate exception to the shorter
  defaults.

A timed-out command is killed (including its process tree) and reported as
`CommandTimeoutError` with the deadline and command in the message. These
deadlines are fail-closed bounds, not retry budgets: they turn an indefinitely
stuck session into a recoverable, reported failure.
