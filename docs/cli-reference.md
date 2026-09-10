# CLI reference

This page is for operators automating or tuning Ralphie. It is the authoritative
reference for invocation syntax, option defaults, environment variables, and
common recipes. Return to the [documentation index](README.md) for suggested
reading paths.

> [!CAUTION]
> The default `lgtm` workflow commits and pushes directly to the selected
> branch. Use `--dry-run --max-issues 1` first, and read the [safety model](safety.md)
> before using mutation-enabled recipes.

## Invocation

```text
bunx @beremaran/ralphie <repository> [options]
```

`<repository>` is required and accepts an `owner/name` slug or a GitHub
HTTPS/SSH clone URL. Extra positional arguments are rejected. When running from a source checkout, replace the package
runner with `bun run index.ts`.

Run `bunx @beremaran/ralphie --help` for the help generated from the current
command schema.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--on-needs-attention <policy>` | `halt` | Halt with exit status `2`, or `continue` through the remaining queue, when an issue needs attention. |
| `--on-issue-failure <policy>` | `halt` | Halt on an ordinary issue failure, or restore its checkout and continue independent queued work. Continued runs exit non-zero after draining if any issue failed. |
| `--notify-needs-attention` | off | Opt in to publishing needs-attention outcomes as an idempotent GitHub comment and optional label. Notifications are never enabled implicitly. |
| `--needs-attention-label <name>` | none | Add a trimmed, non-empty label to needs-attention notifications; requires `--notify-needs-attention`. |
| `-b, --branch <name>` | `main`, otherwise `master` | Base branch pushed directly after verified delivery. |
| `--max-issues <count>` | unlimited | Positive maximum number of issues charged to this run. |
| `--max-decomposition-depth <count>` | `3` | Positive maximum generated-child lineage depth. Reaching the ceiling leaves the issue open, records needs attention, and continues independent work. |
| `--issue-label <label>` | none | Require a label; repeat the flag to require multiple labels. |
| `--issue-sort <sort>` | `created` | Sort by `created`, `updated`, or `comments`, optionally `:asc` or `:desc`. |
| `--model <provider/model>` | pi settings default | Override the pi model selection. |
| `--thinking <level>` | `medium` | Thinking level for every session (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`); omit or pass `default` for `medium`. |
| `--implementation-attempts <count>` | `3` | Positive number of implementation attempts allowed when sessions leave an unresolved empty diff. |
| `--implementation-fallback-model <provider/model>` | none | Optional model used after the first unresolved empty implementation attempt. |
| `--verify-command <command>` | discovered `bun run check` | Deterministic verification command; repeat to run multiple commands in order. Each command runs under a 30-minute deadline. |
| `--workspace <path>` | `~/.ralphie` | Root directory for repository checkouts and run artifacts. |
| `--dry-run` | off | Preview the issue workflow: assess/routes without implementation, commits, pushes, or GitHub mutations. |
| `--resume <state.json>` | none | Continue a compatible saved run. |
| `--clean <when>` | off | Remove the workspace at `start`, `end`, or `both`; mode-specific dry-run and resume rules are documented under [cleanup](operations-and-recovery.md#cleanup). |
| `--output <mode>` | `default` | Output mode: live transcript and progress, `verbose`, `quiet`, or `json`. |

The short aliases are `-b` for `--branch`, `-h` for `--help`, and `-v` for
`--version`. `--issue-label` and `--verify-command` are repeatable. There is no
configuration file: the repository and every setting are supplied explicitly
as an option or environment variable.

`--max-issues` is charged when an issue is dequeued, not when it succeeds. With
the default `created:asc` sort, issues are processed oldest-first; all issue
work is sequential. Without `--max-issues`, the issue budget is unlimited.
When no branch is configured, Ralphie uses `main` when it exists and otherwise
`master`.

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

### Preview one issue

This performs authentication and Git preflight, prepares a clean checkout,
discovers issues, and asks pi for a complexity decision. It may create or reset
the local workspace and write run artifacts, but it does not ask pi to edit the
repository, create commits, push, or mutate GitHub.

```bash
bunx @beremaran/ralphie owner/repository --dry-run --max-issues 1
```

### Configure a run with CLI flags

```bash
bunx @beremaran/ralphie owner/repository \
  --branch main \
  --issue-label bug \
  --max-issues 10
```

Process bugs from oldest to newest on a non-default branch:

```bash
bunx @beremaran/ralphie owner/repository \
  --branch develop \
  --issue-label bug \
  --issue-sort created:asc \
  --max-issues 10
```

Require multiple labels and let pi choose its configured default model:

```bash
bunx @beremaran/ralphie owner/repository \
  --issue-label bug \
  --issue-label backend
```

Select a pi model and thinking level explicitly:

```bash
bunx @beremaran/ralphie owner/repository \
  --model openai/gpt-5 \
  --thinking high
```

Override the deterministic project gate when needed:

```bash
bunx @beremaran/ralphie owner/repository \
  --thinking high \
  --verify-command "bun run check"
```

`--verify-command` is repeatable. Without it, Ralphie discovers a
`package.json` `check` script and runs `bun run check`; if neither exists it
fails closed before review or commit.

Write machine-readable progress to stdout:

```bash
bunx @beremaran/ralphie owner/repository --max-issues 1 --output json > ralphie.jsonl
```

Start from an empty disposable workspace and remove it after success:

```bash
bunx @beremaran/ralphie owner/repository \
  --workspace /tmp/ralphie \
  --clean both
```

> [!WARNING]
> `--clean start` and `--clean end` delete the selected workspace recursively
> after protected-path checks. Use a path dedicated to Ralphie.

Resume an interrupted run:

```bash
bunx @beremaran/ralphie owner/repository \
  --branch main \
  --resume ~/.ralphie/.ralphie/runs/<run-id>/state.json
```

The repository and branch must match the saved run. Ralphie reconciles the
checkout, queue, active issue, decomposition artifacts, and any commit that may
already have reached the remote before continuing. See [Operations and
recovery](operations-and-recovery.md) before resuming a failed run.

### Run the issue queue

```bash
bunx @beremaran/ralphie owner/repository --max-issues 5
```

The workflow commits and pushes directly to the selected branch. It is not a
wait-for-human-review mode: approved work is committed, the remote head is
revalidated, and the commit is pushed without force before the source issue is
closed.

Read [Workflows](workflows.md) and [Safety](safety.md) before running these
mutation-enabled examples.

## Version and help

`ralphie --version` prints only the release version. For automation,
`ralphie --version --output json` prints a stable object containing `version`
and `commitSha`. Both forms work without a repository, GitHub credentials, or
a model provider. Release builds embed the immutable commit SHA supplied by
the build entry point; local builds use the documented `local` commit sentinel
when no release SHA is supplied.
