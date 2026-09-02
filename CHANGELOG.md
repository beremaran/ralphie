# Changelog

All notable changes to Ralphie are documented here. The project follows
[Semantic Versioning](https://semver.org/) and the Keep a Changelog structure.

## [Unreleased]

- Correct the runtime documentation: verified standalone binaries and Docker
  images run without Bun, while Bun remains required for source and published
  JavaScript usage; target-repository verification commands keep their own
  dependencies.
- Add deterministic SPDX 2.3 SBOMs for the four final native release assets;
  each document binds the validated source, build inputs, and final binary digest.
- Add an exact-tag GitHub release verifier that emits a deterministic,
  checksum-verified Homebrew asset manifest.
- Build each native release binary with its explicit Bun target and validate its
  executable header and architecture before emitting checksums.
- Add an explicit local Octokit test seam and a deterministic in-memory GitHub
  REST fixture (`src/github/rest-fixture.ts`). The production client with no
  test configuration still targets `api.github.com` with its existing `gh`
  authentication and REST-version header; only an explicit loopback fixture URL
  (option or `RALPHIE_GITHUB_REST_FIXTURE_URL`/`_TOKEN`) redirects REST traffic,
  and the fixture rejects unknown/public-shaped paths instead of forwarding them.

### Fixed
- Live Pi transcript streaming renders every `thinking_delta` / `text_delta`
  (and tool output update) inline on the already-open `⋯ thinking` / `✦ assistant`
  row instead of forcing one token per `│`-prefixed line; incremental deltas no
  longer break the open stream, so interactive output wraps naturally at the
  terminal width and durable progress/breadcrumb lines still interleave cleanly.
- Structured decision tools now hand providers a flattened single-object schema
  for discriminated-union decisions (issue grounding, needs attention), and
  explicit `null` arguments are stripped before validation. Providers and models
  that silently drop tool-call arguments for root-level `oneOf` tool schemas
  (for example, GLM relays failing every `submit_result` with empty arguments)
  can now comply, while branch-strict requirements remain enforced by the Zod
  decision validation.
- Repeated `submit_result` attempts that never produce a schema-valid result now
  trip a circuit breaker that aborts the Pi session after five consecutive
  failures and reports the likely cause (including dropped tool-call arguments)
  instead of letting the model retry until the prompt-attempt budget expires.
- Flattened decision schemas now declare every branch-only property explicitly
  nullable (scalar fields as `anyOf` unions with a null variant, object/array
  fields with a widened `type`) and annotate each with the dispositions it
  applies to, so strict constrained samplers that materialize every property
  can express "not applicable" as a real `null` instead of forcing invalid
  values; the literal string `"null"` that some samplers emit for enum-typed
  fields is normalized to a real null before tool validation. These cross the
  tool boundary as absents, so a grounding or needs-attention decision can no
  longer get stuck in the `submit_result` retry loop when the provider fills
  every flattened field.

### Changed

- The protected native release publisher now gates on every validated build
  matrix result, regenerates `SHA256SUMS`, and creates or reuses a
  REST-validated release handle before any asset mutation. Reruns verify
  downloaded existing assets byte-for-byte, add only missing assets, and fail
  closed on differing payloads; published releases are reconciled without
  replacement.
- Added `--max-decomposition-depth` (default `3`) and persisted it in run state.
  A direct or review-escalated decomposition beyond the configured ceiling now
  leaves the issue open as `decomposition_limit_reached` needs attention and
  continues independent queued work instead of failing and halting the run;
  dependent issues remain blocked.

- Pi implementation sessions now allow ordinary composed shell commands,
  pipes, redirection, and interpreters while continuing to reject explicit
  orchestration-owned Git/GitHub mutations.
- Implementation completion is schema validated. Unresolved empty diffs enter
  a bounded fresh-session retry loop with verifier evidence, configurable
  implementation thinking, retry count, and optional fallback model.
- A tentative `already_resolved` grounding route now continues through
  complexity assessment when fresh verification finds unresolved work. The
  verifier evidence seeds the first implementation session, unresolved
  resolution artifacts cannot short-circuit resumed work, and operational or
  malformed verification failures still fail closed.
- `--on-issue-failure continue` restores failed issue checkouts and drains
  independent queued work before returning an aggregate non-zero result;
  failed prerequisites continue to block dependent issues.

- Deterministic verification command failures now enter a bounded repair loop
  instead of immediately failing the issue and halting the queue. Each repair
  receives the exact staged diff and bounded failed-command evidence in a fresh
  mutating session, is restaged and reverified, and must pass before review or
  commit. Repairs that change an approved staged tree force another review;
  exhausted repairs and verification integrity faults still fail closed.

- Decomposition now uses native GitHub sub-issues and dependencies: every
  created or recovered child is attached to the original issue as a native
  sub-issue, declared `dependsOn` edges become native `blocked_by`
  relationships, and the decomposed parent stays open as a tracking issue
  instead of being closed as a duplicate. Child bodies keep only the stable
  recovery marker and dependency list, and decomposed parents are never
  re-queued for execution. Native relationships are reconciled idempotently on
  resume; conflicting hierarchy or markers halt with a recovery diagnostic.
- Dequeued issues are refreshed from GitHub before branch or Pi work; closed or
  label-ineligible issues are durably skipped without mutations, and cached
  grounding, complexity, and resolution decisions now require matching live
  issue freshness metadata.
- The `pr` workflow now gates merged delivery: after creating or finding the
  matching feature-branch pull request it persists the PR number and head SHA,
  publishes review attempts, waits for the exact-SHA check observer to reach
  its documented green state, re-reads the PR immediately before merging, and
  invokes the expected-head merge only while the head is unchanged. A failed,
  cancelled, timed-out, absent, unknown, changed-head, closed, or unmergeable
  gate retains the feature branch and PR, persists an active recoverable
  closure gate, and never merges or closes the source issue; resume locates
  the existing PR instead of duplicating it, continues polling pending gates,
  invalidates saved green evidence on a changed head, re-observes failed
  gates on a later rerun, and reconciles an already-merged PR without another
  merge call. Run state version 6 records the PR number, observed head SHA,
  latest normalized check snapshot, observation start/last-update timestamps,
  gate status, and terminal reason for an active PR closure, with migration
  coverage for versions 2–5. The `lgtm` workflow and dry-run paths are
  unchanged, and GitHub mutations remain in the deterministic `src/github/`
  services.

### Added

- `bun run probe:structured-output` accepts `--union` to pre-flight a model
  against the exact grounding decision contract (flattened as production sends
  it) plus `--model provider/model`, `--agent`, and `--variant` for targeting a
  specific model before a run.
- The `pr` gate now streams dedicated `pr-gate` progress events for
  registration (pull-request number and exact head SHA), poll progress only
  for meaningful check transitions (registration, checks registering,
  appearing or disappearing, and status changes — unchanged polls never
  emit), head invalidation, and terminal success/failure, timeout, and
  cancellation with the check summary and reason. Human and verbose output
  explain the PR number, exact SHA, check summary, and reason; JSON output
  exposes the structured normalized snapshot and timestamps; quiet output
  suppresses the routine gate milestones while still reporting gate failures.
  The observer exposes an optional `onTransition` callback invoked only on
  meaningful transitions, and a merged gate record now retains the green
  observation snapshot as persistent merge evidence.
- Deterministic PR-gate regression coverage: a local end-to-end PR workflow
  with a fake GitHub check service that records merge calls and proves none
  occur before a stable green snapshot, resume from pending/green/failed and
  already-merged gate states, unknown and cancelled gate outcomes, expected-head
  merge rejection recording a stale gate, pending-to-failure and mixed Check
  Run/commit-status transitions, and quiet/JSON rendering of gate events.

- A deterministic, read-only pipeline observation service
  (`src/github/pipeline-observation.ts`) that polls normalized pipeline
  snapshots for one exact SHA: it tolerates an initial registration grace
  period while no checks are visible, keeps polling while any item is pending,
  requires configurable stable terminal confirmations, fails closed on
  unknown, cancelled, failing, and empty terminal results, collects every
  page from Check Runs and legacy commit statuses, uses bounded exponential
  backoff and bounded rate-limit retries with delta-seconds, HTTP-date, and
  reset metadata without retrying before server hints or sleeping past an
  absolute deadline, honors caller cancellation reasons, emits only
  meaningful state transitions, and finishes with a race-safe remote-HEAD
  check that reports a stale result when the branch advances so callers can
  follow a newly advanced HEAD.
- An opt-in `RALPHIE_RUN_GITHUB_SUB_ISSUES_SMOKE` integration test that
  exercises the real native sub-issue and dependency API in a configured
  sandbox repository: attachment and dependency idempotency, reads, live
  parent-completion reconciliation, and cleanup.
- Deterministic decomposed-parent completion: finishing the final child
  reconciles its tracking parent immediately, and every non-dry-run run
  reconciles discovered decomposed parents, closing a parent as `completed`
  only when every native sub-issue is closed. Parents awaiting sub-issue
  attachment recovery, non-Ralphie parents, and already-closed parents are
  left untouched.
- Dry-run decomposition reporting: a complexity 4–5 dry run performs the
  read-only breakdown session and reports the intended native sub-issue
  hierarchy — children to create or reuse, sub-issue attachments, dependency
  edges, and the open tracking parent — without mutating GitHub or writing
  artifacts. An unverified needs-attention signal from the planning session is
  reported as a needs-attention route without invoking recovery.
- A deterministic GitHub issue-relationship domain service
  (`src/github/issue-relationships.ts`) that lists, attaches, and validates
  native sub-issues and dependencies with idempotent, response-loss-safe
  mutations and actionable unsupported-endpoint errors.
- A terminal output controller (`src/progress/terminal-controller.ts`) that
  wraps the footer view scheduler and the shared `ProgressOutput` primitives
  and arbitrates every transcript/raw write with the terminal stream boundary
  tracker: an active footer is cleared before transcript or durable progress
  output, token deltas are forwarded immediately, and the footer is restored
  only at safe line boundaries. Durable progress lines are deferred while a
  transcript fragment is open mid-line so progress never merges with,
  overwrites, or falsely closes the fragment; footer bytes are emitted only
  through the strategy's footer surface and never enter transcript/control
  payload or durable scrollback; every replacement repaint clears a visible
  footer before drawing the new one; durable transcript breadcrumbs remain
  the safe default fallback with cursor-reserved-row behavior disabled by
  default. Coverage exercises partial transcript lines, progress
  interleaving, immediate token forwarding, split ANSI/control strings,
  footer suppression while unsafe, restoration after a safe boundary, and
  strict clear-before-draw ordering through fake sinks and fake strategies.
- A persisted `created-issue-dependencies` artifact that records each child's
  dependency issue numbers so queue eligibility never depends on live GitHub
  state alone.

- A maintainer-approved public source and distribution topology, with one
  canonical repository, endpoint inventory, publication setup, and explicit
  privacy boundaries.
- The maintainer-approved MIT license and consistent npm, Homebrew, and OCI
  metadata, including license inspection before container publication.
- A single package-version authority with build-time commit metadata and plain
  or JSON `--version` output that works without repository or Pi configuration.
- An isolated package smoke check that inspects the tarball allowlist, installs
  production dependencies in a fresh project, and verifies scoped identity and
  manifest-backed `--version` output.
- An anonymous public-distribution verification command and scheduled workflow
  that check canonical links, release assets, the temporary installer,
  Homebrew, GHCR, and license metadata without GitHub credentials.
- Staged-tree-bound deterministic verification before review, after review
  fixes, and before commit, with persisted command evidence and repeatable
  `--verify-command` overrides.
- Stage-specific thinking controls for grounding, complexity routing, review,
  and commit-message generation.
- Discriminated top-level CLI configuration for issue,
  `maintain-issues`, and `get-pipelines-green` modes, including duplicate
  handling policy, bounded attempts, and strict pipeline timeout values.
- Read-only issue grounding with a persisted needs-attention deferral: blocked
  issues keep their evidence, questions, and freshness fingerprint, remain
  open, and are never closed or marked complete; complexity is never a
  needs-attention reason.
- An explicit `halt` (default) / `continue` needs-attention policy with
  versioned run-state migration, resume conflict protection, exit status `2`
  for handled stops and exit `0` only when `continue` drains the queue.
- Confirmed needs-attention recovery that atomically preserves bounded,
  binary-safe worktree diagnostics before restoring and verifying the exact
  clean issue checkpoint.
- Resumable needs-attention handoffs with one fresh read-only verifier for every
  executor signal, immutable confirmation before recovery, and idempotent,
  freshness-bound diagnostics across interruptions.
- Durable needs-attention notification recovery: structured outcomes and label
  intent are saved before GitHub mutation, and resume retries the stable marker
  without rerunning agent work.
- An explicit, disabled-by-default `--notify-needs-attention` CLI opt-in with a
  trimmed `--needs-attention-label`; label-only usage is rejected, dry runs
  never notify, and failed notifications retain their intent for safe resume
  and retry.
- Native Bun CLI foundation with GitHub, Git, workspace, and Pi domain
  services.
- Resumable issue execution with complexity routing, bounded review loops,
  deterministic commits and pushes, and dependency-aware decomposition.
- Typed progress events, JSON Lines output, diagnostics, and credential
  redaction.
- Structured no-change resolution verification with persisted evidence.

### Changed

- Refresh each issue before mandatory grounding, route actionable work through
  the existing complexity thresholds, require fresh concrete verification for
  already-resolved closure, and keep needs-attention outcomes out of closure
  and PR delivery. Complexity is never a needs-attention reason.
- Read container candidate digests from the supported Buildx action output,
  serialize every candidate contract field explicitly, and use the supported
  Intel macOS runner so release staging fails closed without hanging or writing
  null promotion metadata.
- Use the supported Sigstore GitHub verification selectors in the standalone
  installer and release documentation, preserving the exact workflow, event,
  commit, and protected tag constraints.
- Expose the canonical repository as an explicit public Homebrew custom tap and
  install the selected release asset under the expected `ralphie` executable
  name.
- Document the cross-mode display contract: interactive sticky footer and
  contextual Pi session output, periodic and lifecycle breadcrumbs, the
  `LIVE_OUTPUT_LIMIT` character threshold and human-preview defaults, active
  leaf-stage status, append-only plain/CI output, quiet output limited to
  failures and handled needs-attention stops,
  lossless JSON Lines without human breadcrumb records, and the independent
  durable progress-event log, including redaction and cleanup behavior.
- Expose grounding and needs-attention decisions consistently across default,
  interactive, verbose, quiet, and JSON Lines output, including complete
  evidence, questions, artifact paths, policy, and final outcome counts.
- Make dry-run grounding and routing strictly read-only: report all routes,
  reuse persisted decisions without rewriting issue artifacts, and keep resumed
  dry runs away from implementation, delivery, and Git/GitHub mutations.
- Refresh live issue and comment metadata when resuming pending work, and reuse
  needs-attention grounding only while its freshness fingerprint matches;
  changed or invalid artifacts are atomically invalidated before regrounding.
- Keep Pi configuration separate from persistent workspace state: explicit
  `--pi-dir` directories remain operator-owned, while environment-generated
  configuration uses a private temporary directory with secure permissions and
  cleanup on close or startup failure.
- Add a deterministic Homebrew formula generator that consumes explicit,
  version-tag-bound release metadata, validates the exact four lowercase
  checksums, and updates only the marked formula metadata region.
- Add exact per-platform Homebrew formula checksums and a validator that checks
  them against the canonical release manifest.
- Make the standalone installer fail closed by requiring the signed checksum
  manifest, exact platform entry, and atomic temporary-file replacement.
- Sign the exact `SHA256SUMS` bytes with keyless Sigstore through GitHub OIDC,
  publish the canonical `SHA256SUMS.sigstore.json` bundle, and document the
  downstream trust policy.
- Publish a deterministic SHA256SUMS manifest alongside the four native
  release binaries, hashing the exact files uploaded to GitHub.
- Publish multi-architecture Docker images from inspected, immutable
  candidates with validated version and revision OCI metadata, using an
  explicit normalized-version tag and stable-only `latest` alias.
- Define the container runtime contract as UID/GID `65532:65532` with
  `/home/nonroot` as `HOME` and the working directory, and include the
  external GitHub, Git, Pi search, shell, and CA-certificate dependencies.
- Define noninteractive `github.com` authentication through the preferred
  `GH_TOKEN` and fallback `GITHUB_TOKEN` environment variables, without
  requiring `gh auth login` or a mounted GitHub CLI profile.
- Stage and smoke-test immutable `linux/amd64` and `linux/arm64` container
  candidates from the validated release ref, including per-platform OCI
  archives, image digests, and promotion metadata; defer registry publication
  to the protected publisher.
- Enforce a validated release tag/version/ref context, immutable protected
  release tags, protected publisher environment, least-privilege workflow
  permissions, and safe manual dry runs.
- Make native release publication idempotent by explicitly targeting the
  canonical repository, reusing an existing tag release, and repairing partial
  asset uploads on retries.
- Publish the scoped npm package only from a validated release tag with npm
  trusted publishing, provenance, and exact post-publication registry smoke
  verification.
- Document the published scoped Bun package and use
  `bunx @beremaran/ralphie` for installation, version verification, dry-run,
  and workflow examples; the scope distinguishes this CLI from the unrelated
  unscoped npm package named `ralphie`.
- Resolve dependencies on decomposed closed issues to their open descendants,
  stop repeated identical review findings early, permit safe compound shell
  inspection commands, and use GitHub REST API version `2026-03-10`.
- Polish human-readable Pi streaming with grouped session blocks, readable tool
  calls, indented de-duplicated tool output, bounded previews, and safe handling
  of terminal control sequences while preserving the lossless JSON event stream.
- Stream the complete Pi event transcript, including token-level thinking and
  assistant output plus tool calls and results, and remove parallel issue and
  Pi session execution.
- Consolidate the CLI surface: fold `--issue-order` into
  `--issue-sort <field>[:asc|desc]`; replace
  `--model-variant` with `--thinking` and `--agent-dir` with `--pi-dir`;
  replace `--start-clean` and `--cleanup` with `--clean <start|end|both>`;
  and replace `--verbose`, `--json`, and `--quiet` with
  `--output <default|verbose|quiet|json>`.
- Drop the `--agent` compatibility label and the `--model-base-url`,
  `--api-key`, `--model-provider`, and `--model-id` flags: model selection is
  owned by `--model <provider/model>` and credentials come from the
  `RALPHIE_MODEL_BASE_URL` and `RALPHIE_MODEL_API_KEY` environment variables.

### Added

- Native Bun CLI foundation with GitHub, Git, workspace, and Pi domain
  explicit service factories, and an ordinary runtime dependency object.
- Focus execution on one required repository and accept all configuration through
  CLI arguments and flags; remove JSON configuration, named projects, repository
  patterns, and multi-repository orchestration.
- Replace the OpenCode SDK and local server with the upstream
  `@earendil-works/pi-coding-agent` SDK, an embedded shared `ModelRuntime`,
  isolated in-memory Pi sessions, guarded tools, and terminating structured-output
  tools validated by Zod.
- Rely on the authoritative non-force Git push for GitHub branch policy and
  permission enforcement while retaining destination, commit, and divergence
  safety checks.
- Render interactive progress through one stderr status line with nested-stage
  tracking instead of creating OpenTUI spinner renderers.
- Close completed implementation issues after verified delivery, with
  idempotent recovery for interrupted or ambiguous GitHub responses.

### Fixed

- Prevent final progress events from recreating a workspace removed by
  `--clean end`.
- Prevent viewport repainting, split-stream output, and accumulating
  `CliRenderer` destroy listeners during long runs.
- Prevent no-change agent runs from being silently skipped without proving
  whether the issue is already resolved.

[Unreleased]: https://github.com/beremaran/ralphie/commits/main
