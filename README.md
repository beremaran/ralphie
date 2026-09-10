# Ralphie

**Turn a GitHub issue queue into reviewed commits with pi.**

[![CI](https://github.com/beremaran/ralphie/actions/workflows/ci.yml/badge.svg)](https://github.com/beremaran/ralphie/actions/workflows/ci.yml)

Ralphie is an opinionated, resumable CLI that reads open GitHub issues, asks
[pi](https://pi.dev/docs/latest) for schema-validated decisions, and
routes each issue to either focused implementation or dependency-aware
decomposition. Agents handle reasoning and code changes; Ralphie keeps Git,
GitHub, run state, recovery, and safety checks deterministic.

> [!CAUTION]
> Ralphie defaults to the `lgtm` workflow: it works directly on the branch
> selected by `--branch`, commits approved work, and pushes directly to that
> branch. Use `--workflow pr` to deliver through an automatically merged feature
> branch and pull request instead. Ralphie is pre-1.0. Start with a one-issue
> `--dry-run` against a repository you control before enabling mutations.

## Quick start

Run the latest release without installing globally:

```bash
bunx @beremaran/ralphie --version
```

Preview one issue without implementation, commits, pushes, or GitHub mutations:

```bash
bunx @beremaran/ralphie owner/repository --dry-run --max-issues 1
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
