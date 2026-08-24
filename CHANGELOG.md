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

### Changed

- Rely on the authoritative non-force Git push for GitHub branch policy and
  permission enforcement while retaining destination, commit, and divergence
  safety checks.

### Fixed

- Prevent final progress events from recreating a workspace removed by
  `--cleanup`.

[Unreleased]: https://github.com/beremaran/ralphie/commits/main
