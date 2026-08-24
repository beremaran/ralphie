# Ralphie implementation backlog

Ralphie now connects its typed executors to a resumable, refreshable issue loop.
The remaining work focuses on interruption recovery, progress completeness,
remote safety checks, end-to-end validation, and release readiness.

The tasks below are ordered roughly by dependency. Each checkbox should be small
enough to implement, review, and commit independently.

## 1. Execution foundations

- [x] Define `IssueExecutionOutcome` variants for completed, decomposed,
      escalated, skipped, and failed issues.
- [x] Define an `IssueExecutionContext` containing the issue, repository path,
      target branch, workspace, run ID, Octokit client, OpenCode client, and
      model/agent selection.
- [x] Add an `IssueExecutor` Effect service that accepts an execution context and
      returns an `IssueExecutionOutcome`.
- [x] Add explicit `ImplementationExecutor` and `DecompositionExecutor` services.
- [x] Keep stage enums as the audit/progress vocabulary rather than building an
      untyped generic stage interpreter.
- [x] Add a typed per-issue artifact store for complexity, checkpoints, reviews,
      commit messages, breakdowns, and created issue numbers.
- [x] Reject reads of artifacts that have not been produced yet.
- [x] Assemble executor services in the live runtime.
- [x] Replace the workflow's plan-only logging with calls to `IssueExecutor`.
- [x] Add mocked executor tests proving the workflow handles every outcome.

## 2. OpenCode task/session layer

- [x] Add a shared helper for creating a fresh OpenCode session in the repository
      directory with the selected agent, model, and variant.
- [x] Add a helper for non-structured agent tasks that returns session metadata
      and the final response.
- [x] Reuse `requestStructuredOutput` for every decision task.
- [x] Add typed handling for OpenCode assistant errors, aborts, output-length
      failures, and structured-output retry exhaustion.
- [x] Record every OpenCode session ID in the run diagnostics.
- [x] Ensure session failures produce progress failure events with useful context.
- [x] Define a permission/tool policy that prevents agents from committing,
      pushing, changing branches, or mutating GitHub directly.
- [x] Verify repository branch and `HEAD` invariants after every agent session.
- [x] Decide whether successful sessions are retained for inspection or deleted.
- [x] Add mocked SDK tests for fresh-session behavior and selection propagation.

## 3. Prompt construction

- [x] Add a prompt builder for complexity assessment using issue title, body,
      labels, and relevant repository context.
- [x] Document the 0–5 complexity rubric in the complexity prompt.
- [x] Add a prompt builder for issue implementation with explicit scope and Git
      restrictions.
- [x] Add a review prompt that receives only the issue and staged diff.
- [x] Add a fresh-context review-fix prompt containing the structured review.
- [x] Add a commit-message prompt based on the issue and final staged diff.
- [x] Add a decomposition prompt that requires independently actionable 0–3
      child issues and an acyclic dependency graph.
- [x] Include failed review summaries when escalation invokes decomposition.
- [x] Unit-test prompt builders with issues that have empty bodies and labels.
- [x] Add prompt-size safeguards for very large issue bodies and diffs.

## 4. Complexity assessment and routing

- [x] Execute the complexity assessment with `complexityDecisionSchema`.
- [x] Emit started, succeeded, and failed complexity progress events.
- [x] Store the decision and rationale in the issue artifact store.
- [x] Route complexity 0–3 to `ImplementationExecutor`.
- [x] Route complexity 4–5 to `DecompositionExecutor`.
- [x] Treat invalid or missing decisions as issue failures without mutating Git or
      GitHub.
- [x] Add executor tests covering every complexity value from 0 through 5.
- [x] Add a real OpenCode smoke test for complexity assessment.

## 5. Deterministic Git issue operations

- [x] Capture and store the clean issue-base checkpoint before an implementation
      session begins.
- [x] Fail before agent work if the branch or checkout is not clean.
- [x] Add a deterministic `git add --all` operation.
- [x] Add an operation to read the exact staged binary diff.
- [x] Add an operation to detect an empty staged change set.
- [x] Define behavior for an agent that reports success but produces no changes.
- [x] Require a fresh structured resolution decision with concrete evidence
      before treating a no-change implementation as completed.
- [x] Add a deterministic commit operation that accepts the validated generated
      subject and optional body.
- [x] Verify the created commit contains the expected staged tree.
- [x] Add a non-force push operation targeting the configured branch.
- [x] Detect and clearly report non-fast-forward push rejection.
- [x] Decide and implement the remote-movement policy: halt, fetch/retry, or
      restart the issue from the new remote base.
- [x] Verify a successful push placed the expected commit on the remote branch.
- [x] Verify the checkout is clean after commit and push.
- [x] Add temporary-repository integration tests for checkpoint, stage, diff,
      restore, commit, and push operations.

## 6. Implementation workflow

- [x] Run the implementation agent in a fresh session on the prepared checkout.
- [x] Check agent session success before inspecting changes.
- [x] Verify the agent did not create commits or switch branches.
- [x] Stage all changes deterministically after implementation.
- [x] Start review attempt 1 using the staged diff.
- [x] Validate review output with `reviewDecisionSchema`.
- [x] Treat `approved` as convergence, including reviews with only non-blocking
      findings.
- [x] For `changes_requested`, start a fresh review-fix session with the review.
- [x] Restage all changes after each review-fix session.
- [x] Repeat review/fix for at most `REVIEW_ITERATION_LIMIT` reviews.
- [x] Do not run another fix session after the fifth rejected review.
- [x] Emit attempt/max-attempt progress on every review and fix.
- [x] Preserve every review decision and session ID in order.
- [x] Generate and validate a commit message after approval.
- [x] Commit and push using deterministic Git operations.
- [x] Return a completed outcome containing commit SHA and review count.
- [x] Close successfully pushed and independently verified already-resolved
      issues with GitHub's completed reason.
- [x] Persist issue closure as a recoverable, idempotent stage.
- [x] Add tests for first-pass approval, approval after fixes, no-change output,
      agent failure, review failure, commit failure, and push failure.

## 7. Review-exhaustion escalation

- [x] Invoke `IssueRecovery.handleReviewExhaustion` after the fifth rejected
      review.
- [x] Confirm the recovery bundle contains the complete staged binary patch.
- [x] Confirm metadata contains all five decisions and session IDs.
- [x] Halt without reset if diagnostic preservation fails.
- [x] Halt if checkout restoration cannot be verified.
- [x] Select the decomposition workflow explicitly after successful restoration.
- [x] Pass failed-review context to the decomposition agent.
- [x] Report escalation as a successful issue transition, not a successful code
      implementation.
- [x] Add an integration test covering implementation, five rejected reviews,
      restore, and decomposition handoff.

## 8. GitHub decomposition operations

- [x] Add a GitHub service for creating issues through Octokit.
- [x] Add a GitHub service for updating issue titles and bodies.
- [x] Add a GitHub service for closing the original issue with the chosen reason.
- [x] Define the rendered Markdown format for parent, sibling, and dependency
      links.
- [x] Create child issues in a deterministic order.
- [x] Record the mapping from breakdown keys to GitHub issue numbers immediately
      after each creation.
- [x] Perform a second update pass after all issue numbers are known so every
      child links the parent, siblings, and dependencies.
- [x] Rewrite the original issue with the complete child-issue stack.
- [x] Close the original only after every child has been created and linked.
- [x] Preserve the original issue content in the rewritten body.
- [x] Include decomposition lineage/depth metadata in generated issue bodies.
- [x] Add a maximum decomposition depth to prevent recursive splitting forever.
- [x] Define what happens if a child is reassessed as complexity 4 or 5.
- [x] Add Octokit tests for successful creation, linking, rewriting, and closure.

## 9. Partial GitHub failure and idempotency

- [x] Persist decomposition progress before the first GitHub mutation.
- [x] Persist each created issue number as soon as GitHub returns it.
- [x] Add a stable marker to generated issue bodies so reruns can identify them.
- [x] On retry, discover already-created children instead of duplicating them.
- [x] Resume linking when creation succeeded but updates failed.
- [x] Leave the original issue open when child creation or linking is incomplete.
- [x] Make original-issue rewriting idempotent.
- [x] Make original-issue closure idempotent.
- [x] Emit a recovery path when GitHub mutation state is ambiguous.
- [x] Add failure-injection tests after every individual GitHub mutation.

## 10. Refreshable main issue loop

- [x] Replace `selectIssues` snapshot iteration with `createIssueQueue`.
- [x] Count an issue against `--max-issues` when execution begins.
- [x] Mark successfully completed, decomposed, and escalated parent issues as
      completed in the queue.
- [x] Refetch open issues after decomposition succeeds.
- [x] Add newly discovered child issues without duplicating known issues.
- [x] Translate created dependency keys into GitHub issue-number dependencies.
- [x] Skip queued issues whose dependencies are still open.
- [x] Re-evaluate blocked issues after each dependency completes.
- [x] Define the result when all remaining issues are dependency-blocked.
- [x] Preserve the configured sorting policy when refreshing the queue.
- [x] Add tests for refresh, dependency ordering, recursive decomposition, and
      issue-budget exhaustion.

## 11. Run state and resume

- [x] Define a versioned run-state JSON schema.
- [x] Persist run ID, repository, branch, model selection, issue budget, queue,
      completed outcomes, and active issue state.
- [x] Write state atomically using a temporary file and rename.
- [x] Validate persisted state before loading it.
- [x] Add a `--resume` flag or a separate resume command.
- [x] Refuse resume when repository or branch arguments do not match the run.
- [x] Reconcile saved state with current Git and GitHub state.
- [x] Define recovery for interruption during agent work, commit, push, child
      creation, linking, and original closure.
- [x] Mark successful runs complete without deleting diagnostics unexpectedly.
- [x] Decide how `--cleanup` interacts with resumable and completed run state.
- [x] Add tests for corrupted, stale, partially written, and incompatible state.

## 12. Progress and diagnostics integration

- [x] Emit progress for every real OpenCode, Git, GitHub, recovery, and queue
      transition.
- [x] Include issue position and review attempt counters where applicable.
- [x] Include session IDs, commit SHAs, created issue numbers, and diagnostic
      paths only in verbose details or JSON events.
- [x] Ensure secrets and the GitHub token can never appear in progress details.
- [x] Keep interactive live-status transitions balanced on success and failure,
      including nested stages.
- [x] Ensure non-TTY output remains append-only and readable.
- [x] Add a final summary of completed, decomposed, escalated, skipped, and failed
      issues.
- [x] Decide whether one issue failure halts the run or can be configured to
      continue.
- [x] Persist JSON Lines events when resumability is enabled.
- [x] Add snapshot tests for representative human-readable runs.

## 13. Cancellation and process lifecycle

- [x] Pass Bunli's `AbortSignal` into the workflow and executors.
- [x] Abort active OpenCode prompts when the user presses Ctrl-C.
- [x] Stop the OpenCode server on success, failure, cancellation, and defects.
- [x] Preserve or restore the active issue checkout on cancellation.
- [x] Persist resumable state before exiting after cancellation.
- [x] Avoid starting another issue once cancellation is requested.
- [x] Return conventional non-zero exit codes for failure and cancellation.
- [x] Add cancellation tests at each long-running boundary.

## 14. Safety and policy

- [x] Detect protected target branches and decide whether explicit confirmation or
      an override flag is required for direct pushes.
- [x] Confirm the authenticated GitHub user can push before agent work begins.
- [x] Detect repository rules or branch protection that make direct pushes
      impossible.
- [x] Refuse force pushes.
- [x] Refuse execution when the local checkout contains unexpected commits ahead
      of or behind the intended base.
- [x] Revalidate origin ownership before every remote mutation.
- [x] Bound issue body, diff, review, and diagnostic artifact sizes.
- [x] Redact credentials and sensitive environment values from errors and logs.
- [x] Document that implementation agents can edit files in the target checkout.
- [x] Add adversarial tests for issue text that attempts to override Git/GitHub
      restrictions.

## 15. End-to-end validation

- [x] Add a fully mocked complexity-2 happy-path test through push.
- [x] Add a fully mocked complexity-4 path through issue closure and queue refresh.
- [x] Add a fully mocked review-exhaustion escalation path.
- [x] Add a fully mocked partial-decomposition resume path.
- [x] Add a local bare-Git-remote integration test for direct branch pushes.
- [x] Add an opt-in real OpenCode complexity-assessment smoke test.
- [x] Add an opt-in real OpenCode implementation/review smoke test in a disposable
      repository.
- [x] Add an opt-in GitHub integration test against a dedicated test repository.
- [x] Run a one-issue dry run against a live repository (`beremaran/issue-ralphing`
      issue #28 was assessed at complexity 1 and routed to implementation without
      mutation on 2026-08-24; `beremaran/opencode-goal` had no open issues).
- [x] Run a disposable end-to-end issue through implementation, review, commit,
      and push.
- [x] Run a disposable end-to-end decomposition and verify all links and closure.

## 16. Documentation and release readiness

- [x] Update the README when the CLI moves from plan-only to executing mutations.
- [x] Document each workflow and its failure/recovery behavior.
- [x] Document `--max-issues` behavior for refreshed child issues.
- [x] Document model, variant, and agent selection examples.
- [x] Document JSON event fields and stability expectations.
- [x] Document workspace, diagnostic, run-state, resume, and cleanup behavior.
- [x] Add a prominent warning that Ralphie pushes directly to the selected branch.
- [x] Add `--dry-run` if users need to validate routing without mutations.
- [x] Add release packaging and installation instructions.
- [x] Add CI for tests, type-checking, builds, and formatting.
- [x] Add a changelog and versioning policy before the first public release.
