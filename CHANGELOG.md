# Changelog

All notable changes to Ralphie are documented here. The project follows
[Semantic Versioning](https://semver.org/) and the Keep a Changelog structure.

## [Unreleased]

### Added

- Read-only issue grounding with a persisted needs-attention escape hatch, so
  dependency-blocked issues remain open while later queue items continue.
- Native Bun CLI foundation with GitHub, Git, workspace, and Pi domain
  services.
- Resumable issue execution with complexity routing, bounded review loops,
  deterministic commits and pushes, and dependency-aware decomposition.
- Typed progress events, JSON Lines output, diagnostics, and credential
  redaction.
- Structured no-change resolution verification with persisted evidence.

### Changed

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
