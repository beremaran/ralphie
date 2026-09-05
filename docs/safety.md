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

## Pipeline mode guardrails

`--mode get-pipelines-green` is a direct base-branch operation with a separate
state machine. It captures one exact remote commit SHA and reads the supported
GitHub sources for that SHA: Check Runs, Check Suites, legacy commit statuses,
and Actions workflow runs. The normalized all-visible-checks policy requires a
non-empty complete set in which every item is `passing`, with no source or
completeness errors, followed by a final authoritative remote-HEAD read that
still equals the observed SHA. `acceptable` neutral/skipped results,
`pending`, `failing`, `cancelled`, and `unknown` states never prove green.
Missing permissions, unsupported endpoints, pagination errors, contradictory
scope, and unknown provider values fail closed. An empty set after the bounded
registration grace is `no-pipelines-discovered`, not success; pending work is
bounded by the absolute pipeline deadline, and the observer can apply a
quiescence window and repeated terminal confirmations.

The mode does not scrape web pages, infer hidden checks, rerun workflows, or
create pull requests. Diagnostics can retrieve only allowlisted job-log
evidence within fixed bounds. CI/provider values are untrusted data: terminal
controls are removed at the artifact boundary, values are not redacted, and
repair prompts enclose the evidence in `<untrusted-pipeline-diagnostics>`
markers so it cannot become an instruction channel.

When a repair is needed, the deterministic boundary captures and persists a
clean checkpoint, verifies the repository and branch before agent work and
again immediately before commit/push, stages and reviews the exact tree, and
uses one non-force push to `HEAD:refs/heads/<branch>`. A push response is not
proof; `git ls-remote`-equivalent authoritative remote evidence must confirm
the created SHA. A concurrent branch advance invalidates the candidate and is
observed rather than overwritten. Only confirmed remote repairs consume
`--max-attempts`; the normalized failure fingerprint prevents the same failure
from cycling through new commits.

Pipeline state is retained on failed, timed-out, ambiguous, or cancelled runs
at `<workspace>/.ralphie/runs/<run-id>/pipeline/state.json`, with diagnostics at
`pipeline/diagnostics.json`. `--resume` validates the repository and branch,
re-reads the remote, invalidates stale evidence, reconciles a possibly lost
push response, and never restarts the saved deadline. If cancellation or
timeout finds the local branch still at the clean checkpoint, an uncommitted
repair is discarded safely; a committed repair is retained for reconciliation.
`--clean end` is available only after a green outcome.

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
Ralphie's run state, events, and recovery artifacts. OpenCode configuration is
supplied through `--opencode-url`/`OPENCODE_URL` and
`--opencode-token`/`OPENCODE_TOKEN`, or through the operator-run local
background service; it is never written under this path. An explicitly supplied
server endpoint is operator-owned and is never removed; keep any server-side
configuration outside the workspace.

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

Pipeline dry-run uses a different, mode-specific boundary:

```bash
bunx @beremaran/ralphie owner/repository \
  --mode get-pipelines-green --branch main --dry-run \
  --pipeline-timeout 10m --output json
```

It authenticates, prepares and inspects the checkout, reads and observes the
current remote HEAD, waits/classifies visible checks, and collects bounded
diagnostics for a failing snapshot. It never starts OpenCode, edits or stages
files, commits, pushes, reruns Actions, mutates GitHub, or creates a pull
request. A failing preview reports what repair would be attempted and exits
`1`; a green preview still performs no delivery. Failed previews retain the
pipeline state and diagnostics for inspection or `--resume`.

The `maintain-issues` dry-run boundary is narrower: it reads the GitHub issue,
comment, label, and repository data needed for one complete maintenance
snapshot, and reads the existing checkout for source grounding, but it does
not prepare, clone, reset, or otherwise mutate the workspace. It does not call
label, comment, relationship, or duplicate-closure services, and it writes no
maintenance state, artifacts, or event log. The output still contains the
validated plan, action outcomes, evidence, and skip reasons, so operators can
check the proposed pass before granting Issues write permission.

## Agent and mutation boundaries

Structured decision sessions deny edits/writes and mutating Git/GitHub commands.
Their required result is returned through OpenCode's structured JSON format and
Ralphie's fenced-JSON parser; a repository-backed blocker is an optional fenced
`needs-attention` block, not a mutation-capable tool. PR-review sessions use an
explicit immutable profile: the committed patch and verification evidence are
supplied in the prompt, and the reviewer cannot inspect the checkout or run
shell/Git/GitHub commands. The implementation agent may edit the checkout, but
it is denied commits, pushes, branch/reset/clean operations, and `gh` commands.
Ralphie stages, verifies, commits, pushes, and mutates GitHub through
deterministic domain services. Every decision task is schema-validated at the
OpenCode response and Ralphie domain boundaries; invalid output or OpenCode
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
