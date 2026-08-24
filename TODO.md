# Ralphie implementation backlog

Ralphie currently performs preflight checks, prepares a clean checkout, fetches
open issues, starts OpenCode, builds typed workflow plans, and reports progress.
The services and schemas for structured output, review-exhaustion recovery, and
refreshable issue queues exist, but they are not yet connected by a live issue
executor.

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
- [ ] Keep stage enums as the audit/progress vocabulary rather than building an
      untyped generic stage interpreter.
- [x] Add a typed per-issue artifact store for complexity, checkpoints, reviews,
      commit messages, breakdowns, and created issue numbers.
- [x] Reject reads of artifacts that have not been produced yet.
- [ ] Assemble executor services in the live runtime.
- [ ] Replace the workflow's plan-only logging with calls to `IssueExecutor`.
- [ ] Add mocked executor tests proving the workflow handles every outcome.

## 2. OpenCode task/session layer

- [x] Add a shared helper for creating a fresh OpenCode session in the repository
      directory with the selected agent, model, and variant.
- [x] Add a helper for non-structured agent tasks that returns session metadata
      and the final response.
- [ ] Reuse `requestStructuredOutput` for every decision task.
- [x] Add typed handling for OpenCode assistant errors, aborts, output-length
      failures, and structured-output retry exhaustion.
- [ ] Record every OpenCode session ID in the run diagnostics.
- [ ] Ensure session failures produce progress failure events with useful context.
- [ ] Define a permission/tool policy that prevents agents from committing,
      pushing, changing branches, or mutating GitHub directly.
- [ ] Verify repository branch and `HEAD` invariants after every agent session.
- [ ] Decide whether successful sessions are retained for inspection or deleted.
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
- [ ] Add a real OpenCode smoke test for complexity assessment.

## 5. Deterministic Git issue operations

- [ ] Capture and store the clean issue-base checkpoint before an implementation
      session begins.
- [ ] Fail before agent work if the branch or checkout is not clean.
- [x] Add a deterministic `git add --all` operation.
- [x] Add an operation to read the exact staged binary diff.
- [x] Add an operation to detect an empty staged change set.
- [ ] Define behavior for an agent that reports success but produces no changes.
- [ ] Add a deterministic commit operation that accepts the validated generated
      subject and optional body.
- [ ] Verify the created commit contains the expected staged tree.
- [ ] Add a non-force push operation targeting the configured branch.
- [ ] Detect and clearly report non-fast-forward push rejection.
- [ ] Decide and implement the remote-movement policy: halt, fetch/retry, or
      restart the issue from the new remote base.
- [ ] Verify a successful push placed the expected commit on the remote branch.
- [ ] Verify the checkout is clean after commit and push.
- [ ] Add temporary-repository integration tests for checkpoint, stage, diff,
      restore, commit, and push operations.

## 6. Implementation workflow

- [ ] Run the implementation agent in a fresh session on the prepared checkout.
- [ ] Check agent session success before inspecting changes.
- [ ] Verify the agent did not create commits or switch branches.
- [ ] Stage all changes deterministically after implementation.
- [ ] Start review attempt 1 using the staged diff.
- [ ] Validate review output with `reviewDecisionSchema`.
- [ ] Treat `approved` as convergence, including reviews with only non-blocking
      findings.
- [ ] For `changes_requested`, start a fresh review-fix session with the review.
- [ ] Restage all changes after each review-fix session.
- [ ] Repeat review/fix for at most `REVIEW_ITERATION_LIMIT` reviews.
- [ ] Do not run another fix session after the fifth rejected review.
- [ ] Emit attempt/max-attempt progress on every review and fix.
- [ ] Preserve every review decision and session ID in order.
- [ ] Generate and validate a commit message after approval.
- [ ] Commit and push using deterministic Git operations.
- [ ] Return a completed outcome containing commit SHA and review count.
- [ ] Add tests for first-pass approval, approval after fixes, no-change output,
      agent failure, review failure, commit failure, and push failure.

## 7. Review-exhaustion escalation

- [ ] Invoke `IssueRecovery.handleReviewExhaustion` after the fifth rejected
      review.
- [ ] Confirm the recovery bundle contains the complete staged binary patch.
- [ ] Confirm metadata contains all five decisions and session IDs.
- [ ] Halt without reset if diagnostic preservation fails.
- [ ] Halt if checkout restoration cannot be verified.
- [ ] Select the decomposition workflow explicitly after successful restoration.
- [ ] Pass failed-review context to the decomposition agent.
- [ ] Report escalation as a successful issue transition, not a successful code
      implementation.
- [ ] Add an integration test covering implementation, five rejected reviews,
      restore, and decomposition handoff.

## 8. GitHub decomposition operations

- [ ] Add a GitHub service for creating issues through Octokit.
- [ ] Add a GitHub service for updating issue titles and bodies.
- [ ] Add a GitHub service for closing the original issue with the chosen reason.
- [ ] Define the rendered Markdown format for parent, sibling, and dependency
      links.
- [ ] Create child issues in a deterministic order.
- [ ] Record the mapping from breakdown keys to GitHub issue numbers immediately
      after each creation.
- [ ] Perform a second update pass after all issue numbers are known so every
      child links the parent, siblings, and dependencies.
- [ ] Rewrite the original issue with the complete child-issue stack.
- [ ] Close the original only after every child has been created and linked.
- [ ] Preserve the original issue content in the rewritten body.
- [ ] Include decomposition lineage/depth metadata in generated issue bodies.
- [ ] Add a maximum decomposition depth to prevent recursive splitting forever.
- [ ] Define what happens if a child is reassessed as complexity 4 or 5.
- [ ] Add Octokit tests for successful creation, linking, rewriting, and closure.

## 9. Partial GitHub failure and idempotency

- [ ] Persist decomposition progress before the first GitHub mutation.
- [ ] Persist each created issue number as soon as GitHub returns it.
- [ ] Add a stable marker to generated issue bodies so reruns can identify them.
- [ ] On retry, discover already-created children instead of duplicating them.
- [ ] Resume linking when creation succeeded but updates failed.
- [ ] Leave the original issue open when child creation or linking is incomplete.
- [ ] Make original-issue rewriting idempotent.
- [ ] Make original-issue closure idempotent.
- [ ] Emit a recovery path when GitHub mutation state is ambiguous.
- [ ] Add failure-injection tests after every individual GitHub mutation.

## 10. Refreshable main issue loop

- [ ] Replace `selectIssues` snapshot iteration with `createIssueQueue`.
- [x] Count an issue against `--max-issues` when execution begins.
- [ ] Mark successfully completed, decomposed, and escalated parent issues as
      completed in the queue.
- [ ] Refetch open issues after decomposition succeeds.
- [x] Add newly discovered child issues without duplicating known issues.
- [ ] Translate created dependency keys into GitHub issue-number dependencies.
- [x] Skip queued issues whose dependencies are still open.
- [x] Re-evaluate blocked issues after each dependency completes.
- [x] Define the result when all remaining issues are dependency-blocked.
- [x] Preserve the configured sorting policy when refreshing the queue.
- [ ] Add tests for refresh, dependency ordering, recursive decomposition, and
      issue-budget exhaustion.

## 11. Run state and resume

- [ ] Define a versioned run-state JSON schema.
- [ ] Persist run ID, repository, branch, model selection, issue budget, queue,
      completed outcomes, and active issue state.
- [ ] Write state atomically using a temporary file and rename.
- [ ] Validate persisted state before loading it.
- [ ] Add a `--resume` flag or a separate resume command.
- [ ] Refuse resume when repository or branch arguments do not match the run.
- [ ] Reconcile saved state with current Git and GitHub state.
- [ ] Define recovery for interruption during agent work, commit, push, child
      creation, linking, and original closure.
- [ ] Mark successful runs complete without deleting diagnostics unexpectedly.
- [ ] Decide how `--cleanup` interacts with resumable and completed run state.
- [ ] Add tests for corrupted, stale, partially written, and incompatible state.

## 12. Progress and diagnostics integration

- [ ] Emit progress for every real OpenCode, Git, GitHub, recovery, and queue
      transition.
- [ ] Include issue position and review attempt counters where applicable.
- [ ] Include session IDs, commit SHAs, created issue numbers, and diagnostic
      paths only in verbose details or JSON events.
- [ ] Ensure secrets and the GitHub token can never appear in progress details.
- [ ] Keep interactive spinner transitions balanced on success and failure.
- [ ] Ensure non-TTY output remains append-only and readable.
- [ ] Add a final summary of completed, decomposed, escalated, skipped, and failed
      issues.
- [ ] Decide whether one issue failure halts the run or can be configured to
      continue.
- [ ] Persist JSON Lines events when resumability is enabled.
- [ ] Add snapshot tests for representative human-readable runs.

## 13. Cancellation and process lifecycle

- [ ] Pass Bunli's `AbortSignal` into the workflow and executors.
- [ ] Abort active OpenCode prompts when the user presses Ctrl-C.
- [ ] Stop the OpenCode server on success, failure, cancellation, and defects.
- [ ] Preserve or restore the active issue checkout on cancellation.
- [ ] Persist resumable state before exiting after cancellation.
- [ ] Avoid starting another issue once cancellation is requested.
- [ ] Return conventional non-zero exit codes for failure and cancellation.
- [ ] Add cancellation tests at each long-running boundary.

## 14. Safety and policy

- [ ] Detect protected target branches and decide whether explicit confirmation or
      an override flag is required for direct pushes.
- [ ] Confirm the authenticated GitHub user can push before agent work begins.
- [ ] Detect repository rules or branch protection that make direct pushes
      impossible.
- [ ] Refuse force pushes.
- [ ] Refuse execution when the local checkout contains unexpected commits ahead
      of or behind the intended base.
- [ ] Revalidate origin ownership before every remote mutation.
- [ ] Bound issue body, diff, review, and diagnostic artifact sizes.
- [ ] Redact credentials and sensitive environment values from errors and logs.
- [ ] Document that implementation agents can edit files in the target checkout.
- [ ] Add adversarial tests for issue text that attempts to override Git/GitHub
      restrictions.

## 15. End-to-end validation

- [ ] Add a fully mocked complexity-2 happy-path test through push.
- [ ] Add a fully mocked complexity-4 path through issue closure and queue refresh.
- [ ] Add a fully mocked review-exhaustion escalation path.
- [ ] Add a fully mocked partial-decomposition resume path.
- [ ] Add a local bare-Git-remote integration test for direct branch pushes.
- [ ] Add an opt-in real OpenCode complexity-assessment smoke test.
- [ ] Add an opt-in real OpenCode implementation/review smoke test in a disposable
      repository.
- [ ] Add an opt-in GitHub integration test against a dedicated test repository.
- [ ] Run a one-issue dry run against `beremaran/opencode-goal`.
- [ ] Run a disposable end-to-end issue through implementation, review, commit,
      and push.
- [ ] Run a disposable end-to-end decomposition and verify all links and closure.

## 16. Documentation and release readiness

- [ ] Update the README when the CLI moves from plan-only to executing mutations.
- [ ] Document each workflow and its failure/recovery behavior.
- [ ] Document `--max-issues` behavior for refreshed child issues.
- [ ] Document model, variant, and agent selection examples.
- [ ] Document JSON event fields and stability expectations.
- [ ] Document workspace, diagnostic, run-state, resume, and cleanup behavior.
- [ ] Add a prominent warning that Ralphie pushes directly to the selected branch.
- [ ] Add `--dry-run` if users need to validate routing without mutations.
- [ ] Add release packaging and installation instructions.
- [ ] Add CI for tests, type-checking, builds, and formatting.
- [ ] Add a changelog and versioning policy before the first public release.
