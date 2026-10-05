# Ralphie

**Turn a GitHub issue queue into reviewed commits with a coding-agent harness.**

[![CI](https://github.com/beremaran/ralphie/actions/workflows/ci.yml/badge.svg)](https://github.com/beremaran/ralphie/actions/workflows/ci.yml)

Ralphie is an opinionated CLI that reads open GitHub issues, asks
a headless coding-agent harness (Claude Code first) for schema-validated
decisions, and
routes each issue to either focused implementation or dependency-aware
decomposition. Agents handle reasoning and code changes; Ralphie keeps Git,
GitHub, run state, diagnostics, and safety checks deterministic.

> [!CAUTION]
> Ralphie works directly on the branch selected in the configuration file, commits approved
> work, and pushes directly to that branch. Ralphie is pre-1.0. Validate against
> a repository you control before enabling mutations.

## Quick start

Run the latest release without installing globally:

```bash
bunx @beremaran/ralphie --version
```

Create `~/.config/ralphie/config.yaml` (an empty file is valid; see
[Configuration](./docs/configuration.md)), then run the issue queue:

```bash
bunx @beremaran/ralphie owner/repository
```

See [Getting started](./docs/getting-started.md) for prerequisites,
authentication, verification, and the full first-run contract, and read the
[safety model](./docs/safety.md) before enabling mutations.

## Documentation

Start with the [documentation index](./docs/README.md). Audience entry points:

- New user: [Getting started](./docs/getting-started.md), then
  [Safety](./docs/safety.md).
- Operator: [Workflows](./docs/workflows.md),
  [CLI reference](./docs/cli-reference.md), and
  [Operations and recovery](./docs/operations-and-recovery.md).
- Contributor: [Development](./docs/development.md) and
  [Architecture](./docs/architecture.md).
- Release maintainer: [Publishing](./docs/development.md#publishing).

## License

Ralphie is [MIT licensed](./LICENSE).
