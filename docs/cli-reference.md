# CLI reference

This page is for operators automating Ralphie. It is the authoritative
reference for invocation syntax, command-line options, environment variables,
and common recipes. Settings live in the [configuration file](configuration.md). Return to the
[documentation index](README.md) for suggested reading paths.

## Invocation

```text
bunx @beremaran/ralphie [owner/]repository [options]
```

`[owner/]repository` is required. It accepts an `owner/name` slug, a GitHub
HTTPS/SSH clone URL, or a bare repository name whose owner comes from
`defaultOwner` or the authenticated `gh` login (see
[Configuration](configuration.md#choosing-a-repository)). Nothing is inferred
from the current directory. Extra positional arguments are rejected. When
running from a source checkout, replace the package runner with
`bun run index.ts`.

Run `bunx @beremaran/ralphie --help` for the help generated from the current
command schema.

> [!CAUTION]
> Ralphie commits and pushes directly to the selected branch. Test against a
> repository you control, and read the [safety model](safety.md) before
> running it.

## Options

All behavior settings live in the [configuration file](configuration.md).
These options remain on the command line:

| Option | Default | Description |
| --- | --- | --- |
| `--config <path>` | `$XDG_CONFIG_HOME/ralphie/config.yaml`, else `~/.config/ralphie/config.yaml` | Read configuration from this file. A missing file is an error. |
| `--set <path=value>` | none | Override one configuration key for this run; repeatable. The path is dotted, a key containing a slash is double-quoted (`repos."owner/repo".branch=develop`), and the value is YAML. Applied after the file and the matching `repos` entry. |
| `--output <mode>` | `default` | Output mode: `default` renders the full-screen TUI on a terminal and plain append-only lines when piped or in CI; `json` writes JSON Lines on stdout. |

The short aliases are `-h` for `--help` and `-v` for `--version`. Former flags
such as `--branch`, `--issue-label`, `--verify-command`, `--model`, and
`--thinking` fail with an error
naming the configuration key that replaces them; the full mapping is in
[Configuration](configuration.md#removed-flags).

Every run processes the entire matching open-issue queue, sequentially, in the
order set by `intake.sort`.

## Environment variables

Ralphie also reads these environment variables:

| Variable | Purpose |
| --- | --- |
| `GH_TOKEN` | GitHub.com token for noninteractive `gh` authentication (preferred). |
| `GITHUB_TOKEN` | Fallback GitHub.com token alias for `gh`. |

For interactive `github.com` use, authenticate with `gh auth login` and verify
with `gh auth status`. For unattended use, provide `GH_TOKEN` (preferred) or
`GITHUB_TOKEN` as an environment input; it does not need to be printed or
exposed. A mounted GitHub CLI profile is not required when an environment token
is provided. This authentication contract covers `github.com` only. See
[Getting started](getting-started.md) for the complete credential and
container setup.

## Common recipes

Run the issue queue with settings from the default config file:

```bash
bunx @beremaran/ralphie owner/repository
```

Use a different config file and a bare repository name:

```bash
bunx @beremaran/ralphie repository --config ./ralphie.yaml
```

Override settings for one run:

```bash
bunx @beremaran/ralphie owner/repository \
  --set 'intake.requireLabels=[bug]' \
  --set 'repos."owner/repository".branch=develop'
```

Choose a model and effort for one run with `--set` (see
[Configuration](configuration.md#harnesses-and-roles)):

```bash
bunx @beremaran/ralphie owner/repository \
  --set harnesses.claude.model=opus \
  --set harnesses.claude.effort=high
```

Write machine-readable progress to stdout:

```bash
bunx @beremaran/ralphie owner/repository --output json > ralphie.jsonl
```

The workflow commits and pushes directly to the selected branch. It is not a
wait-for-human-review mode: approved work is committed, the remote head is
revalidated, and the commit is pushed without force before the source issue is
closed. Read [Workflows](workflows.md) and [Safety](safety.md) before running
it, and keep `workspace` pointed at a path dedicated to Ralphie, because the
workspace is deleted recursively before preparation and after a successful run.

## Version and help

`ralphie --version` prints only the release version. For automation,
`ralphie --version --output json` prints a stable object containing `version`
and `commitSha`. Both forms work without a repository, GitHub credentials, or
a model provider. Release builds embed the immutable commit SHA supplied by
the build entry point; local builds use the documented `local` commit sentinel
when no release SHA is supplied.
