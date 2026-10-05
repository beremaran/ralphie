# CLI reference

This page is for operators automating or tuning Ralphie. It is the authoritative
reference for invocation syntax, repository resolution, command-line options,
environment variables, and common recipes. Settings are documented in
[Configuration](configuration.md). Return to the [documentation index](README.md) for suggested
reading paths.

> [!CAUTION]
> Ralphie commits and pushes directly to the configured branch. Test against a
> repository you control, and read the [safety model](safety.md) before using
> mutation-enabled recipes.

## Invocation

```text
bunx @beremaran/ralphie <[owner/]repository | clone-url> [options]
```

When running from a source checkout, replace the package runner with
`bun run index.ts`. Run `bunx @beremaran/ralphie --help` for the help generated
from the current command schema.

Every setting lives in the [configuration file](configuration.md); the command
line only selects the repository and a few per-run controls. Ralphie fails with
a message naming the expected path when no configuration file exists.

### Repository resolution

- `owner/repo` and GitHub HTTPS/SSH clone URLs are used as given.
- A bare `repo` gets the owner from `defaultOwner` in the configuration, and
  otherwise from the authenticated `gh` user.
- Ralphie never infers the repository from the current directory.

Extra positional arguments are rejected. The bare word `init` is reserved; use
`owner/init` to target a repository with that name.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--config <path>` | `$XDG_CONFIG_HOME/ralphie/config.yaml` | Load this configuration file instead of the default. |
| `--set <path=value>` | none | Override one configuration key for this run, using the file's dotted paths; repeatable. See [Configuration](configuration.md#overriding-for-one-run-with---set). |
| `--output <mode>` | `default` | Output mode: `default` renders the full-screen TUI on a terminal and plain append-only lines when piped or in CI; `json` writes JSON Lines on stdout. |
| `-h, --help` | | Show help. |
| `-v, --version` | | Show the version (use `--output json` for build metadata). |

Temporary options remain until the harness and hand-off work replaces them with
configuration keys:

| Option | Default | Description |
| --- | --- | --- |
| `--notify-needs-attention` | off | Opt in to publishing needs-attention outcomes as an idempotent GitHub comment and optional label. |
| `--needs-attention-label <name>` | none | Add a trimmed, non-empty label to needs-attention notifications; requires `--notify-needs-attention`. |
| `--model <provider/model>` | pi settings default | Override the pi model selection. |
| `--thinking <level>` | `medium` | Thinking level for every session (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`). |

### Removed options

Each removed flag fails with an error naming its replacement:

| Removed flag | Configuration key |
| --- | --- |
| `-b`, `--branch` | `repos."owner/repo".branch` |
| `--issue-label` | `intake.requireLabels` |
| `--issue-sort` | `intake.sort` |
| `--verify-command` | `repos."owner/repo".verify` |
| `--implementation-attempts` | `limits.implementationAttempts` |
| `--max-decomposition-depth` | `limits.maxDecompositionDepth` |
| `--workspace` | `workspace` |

Every run processes the entire matching open-issue queue. With the default
`created:asc` sort, issues are processed oldest-first; all issue work is
sequential.

## Environment variables

Ralphie also reads these environment variables:

| Variable | Purpose |
| --- | --- |
| `GH_TOKEN` | GitHub.com token for noninteractive `gh` authentication (preferred). |
| `GITHUB_TOKEN` | Fallback GitHub.com token alias for `gh`. |
| `PI_CODING_AGENT_DIR` | Pi config directory (default `~/.pi/agent`); contains `auth.json` and `settings.json`. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, … | Provider credentials for models without a stored pi credential. A stored `auth.json` credential wins over the environment. |

For interactive `github.com` use, authenticate with `gh auth login` and verify
with `gh auth status`. For unattended use, provide `GH_TOKEN` (preferred) or
`GITHUB_TOKEN` as an environment input; it does not need to be printed or
exposed. A mounted GitHub CLI profile is not required when an environment token
is provided. This authentication contract covers `github.com` only. See
[Getting started](getting-started.md) for the complete credential and
container setup.

## Common recipes

Run the issue queue for a repository you own:

```bash
bunx @beremaran/ralphie your-repository
```

Process only bugs, newest-updated first, for one run:

```bash
bunx @beremaran/ralphie owner/repository \
  --set 'intake.requireLabels=["bug"]' \
  --set intake.sort=updated:desc
```

Select a pi model and thinking level explicitly:

```bash
bunx @beremaran/ralphie owner/repository --model openai/gpt-5 --thinking high
```

Write machine-readable progress to stdout:

```bash
bunx @beremaran/ralphie owner/repository --output json > ralphie.jsonl
```

Run from a dedicated disposable workspace:

```bash
bunx @beremaran/ralphie owner/repository --set workspace=/tmp/ralphie
```

> [!WARNING]
> Ralphie deletes the selected workspace recursively before preparation and
> after a successful run, subject to protected-path checks. Use a path dedicated
> to Ralphie.

The workflow commits and pushes directly to the selected branch. It is not a
wait-for-human-review mode: approved work is committed, the remote head is
revalidated, and the commit is pushed without force before the source issue is
closed. Read [Workflows](workflows.md) and [Safety](safety.md) first.

## Version and help

`ralphie --version` prints only the release version. For automation,
`ralphie --version --output json` prints a stable object containing `version`
and `commitSha`. Both forms work without a repository, GitHub credentials, or
a model provider. Release builds embed the immutable commit SHA supplied by
the build entry point; local builds use the documented `local` commit sentinel
when no release SHA is supplied.
