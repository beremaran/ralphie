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

Implementation agents may use normal shell composition, pipes, redirection,
and language runtimes. Ralphie's shell hook rejects explicit agent requests for
orchestration-owned Git/GitHub mutations such as commits, pushes, branch
changes, resets, cleans, and `gh` calls. This hook is a guardrail, not a
security sandbox: deterministic repository invariants and the isolated
delivery services remain authoritative.

In `pr` mode, the feature branch, pull request, review comments, and merge are
reconciled through GitHub before the linked issue is considered complete.

Ralphie does not try to predict whether GitHub will accept the update by
querying branch protection, repository rulesets, or API-reported push
permission. The actual non-force `git push` is authoritative and enforces the
repository's current policy without plan-, permission-, or timing-dependent API
guesses. If GitHub rejects the push, Ralphie surfaces the complete Git
response, retains the created commit and run artifacts, and halts for
inspection or resume.

## Workspace risk

There is one intentionally destructive local behavior: when reusing an existing
repository checkout that is not clean, Ralphie runs the equivalent of `git reset
--hard` and `git clean -fd`, then aligns it with the selected remote branch.
Tracked modifications and untracked, non-ignored files inside that checkout are
discarded. Keep unrelated work outside Ralphie's workspace.

The workspace's `.ralphie` directory contains only repository checkouts and
Ralphie's run state, events, and recovery artifacts. Codex configuration is kept
in the default or explicitly supplied `--codex-dir`, or in a private temporary
credential directory, never under this path. An explicitly supplied `--codex-dir`
is operator-owned and is never removed; mount it outside the workspace.

`--clean start` and `--clean end` recursively delete the workspace after
protected-path checks. Use a path dedicated to Ralphie:

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
needs-attention artifacts, and it cannot invoke implementation, decomposition,
delivery, commits, pushes, checkout mutation, or GitHub mutations. A resumed
dry run remains a dry run.

## Agent and mutation boundaries

Structured decision sessions deny edits/writes and mutating Git/GitHub commands.
The implementation agent may edit the checkout, but it is denied commits,
pushes, branch/reset/clean operations, and `gh` commands. Ralphie stages,
verifies, commits, pushes, and mutates GitHub through deterministic domain
services. Every decision task is schema-validated; invalid output or Codex
failure becomes a failed issue outcome without proceeding to the next operation.

Verification commands are run against the staged tree and their evidence is
bound to that tree before review or commit. A non-zero command exit is treated
as actionable implementation feedback: a fresh fix session receives bounded
failure evidence, and Ralphie restages and retries up to five times. Missing
verification configuration, staged-tree mutation, and exhausted repair remain
hard safety stops. The direct-push path never uses force. See
[Workflows](workflows.md) for the complete implementation and delivery sequence,
and [Operations and recovery](operations-and-recovery.md) for what remains
available after a safety stop.
