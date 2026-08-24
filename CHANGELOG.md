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

### Fixed

- Prevent final progress events from recreating a workspace removed by
  `--cleanup`.
- Treat GitHub's explicit rulesets-unavailable response for private repositories
  as zero active rules while continuing to fail closed for other API errors.

[Unreleased]: https://github.com/beremaran/ralphie/commits/main
