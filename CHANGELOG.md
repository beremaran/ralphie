# Changelog

All notable changes to Ralphie are documented here. The project follows
[Semantic Versioning](https://semver.org/) and the Keep a Changelog structure.

## [Unreleased]

### Changed

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

### Added

- A deterministic GitHub issue-relationship domain service
  (`src/github/issue-relationships.ts`) that lists, attaches, and validates
  native sub-issues and dependencies with idempotent, response-loss-safe
  mutations and actionable unsupported-endpoint errors.
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
