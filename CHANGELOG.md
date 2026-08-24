# Changelog

All notable changes to Ralphie are documented here. The project follows
[Semantic Versioning](https://semver.org/) and the Keep a Changelog structure.

## [Unreleased]

### Added

- Bunli and Effect CLI foundation with GitHub, Git, workspace, and OpenCode
  domain services.
- Resumable issue execution with complexity routing, bounded review loops,
  deterministic commits and pushes, and dependency-aware decomposition.
- Typed progress events, JSON Lines output, diagnostics, and credential
  redaction.
- Structured no-change resolution verification with persisted evidence.
- Optional, strictly validated JSON configuration with CLI override precedence.
- Parallel multi-repository execution with per-repository overrides, isolated
  checkouts, progress attribution, and shared workspace lifecycle management.
- Hierarchical configuration with named projects, deterministic repository
  pattern expansion, and project-level repository grouping.

### Changed

- Rely on the authoritative non-force Git push for GitHub branch policy and
  permission enforcement while retaining destination, commit, and divergence
  safety checks.
- Render interactive progress through one stderr status line with nested-stage
  tracking instead of creating OpenTUI spinner renderers.
- Close completed implementation issues after verified delivery, with
  idempotent recovery for interrupted or ambiguous GitHub responses.

### Fixed

- Run batch-wide GitHub authentication, Octokit initialization, Git
  verification, workspace preparation, and OpenCode startup exactly once rather
  than once per configured repository.
- Preserve repository attribution on nested progress emitted by issue and
  OpenCode services during concurrent runs.
- Share batch-wide preflight and OpenCode resources across all repositories while
  retaining independent project and repository execution state.
- Report missing files, malformed JSON, and each schema violation separately
  instead of collapsing every config failure into one generic message.
- Treat `null` optional JSON settings as unset, including an unlimited
  `issues.limit` and no `issues.filter.labels` filter.
- Prevent final progress events from recreating a workspace removed by
  `--cleanup`.
- Prevent viewport repainting, split-stream output, and accumulating
  `CliRenderer` destroy listeners during long runs.
- Prevent no-change agent runs from being silently skipped without proving
  whether the issue is already resolved.

[Unreleased]: https://github.com/beremaran/ralphie/commits/main
