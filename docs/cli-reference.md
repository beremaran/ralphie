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
HTTPS/SSH clone URL. When running from a source checkout, replace the package
runner with `bun run index.ts`.

Run `bunx @beremaran/ralphie --help` for the help generated from the current
command schema.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--mode <mode>` | `issues` | Select `issues`, `maintain-issues`, or `get-pipelines-green`. |
| `--workflow <mode>` | `lgtm` | Select direct-push `lgtm` or automatically merged `pr` delivery in issue mode. |
| `--on-needs-attention <policy>` | `halt` | Halt with exit status `2`, or `continue` through the remaining queue, when an issue needs attention. |
| `--on-issue-failure <policy>` | `halt` | Halt on an ordinary issue failure, or restore its checkout and continue independent queued work. Continued runs exit non-zero after draining if any issue failed. |
| `--notify-needs-attention` | off | Opt in to publishing needs-attention outcomes as an idempotent GitHub comment and optional label. Notifications are never enabled implicitly. |
| `--needs-attention-label <name>` | none | Add a trimmed, non-empty label to needs-attention notifications; requires `--notify-needs-attention`. |
| `--duplicate-action <action>` | `link` | In maintenance mode, link duplicates or close them. |
| `-b, --branch <name>` | `main`, otherwise `master` | Base branch; `lgtm` pushes it directly, while PR workflows open against it. |
| `--max-issues <count>` | unlimited | Positive maximum number of issues charged to this run. |
| `--max-decomposition-depth <count>` | `3` | Positive maximum generated-child lineage depth. Reaching the ceiling leaves the issue open, records needs attention, and continues independent work. |
| `--issue-label <label>` | none | Require a label; repeat the flag to require multiple labels. |
| `--issue-sort <sort>` | `created` | Sort by `created`, `updated`, or `comments`, optionally `:asc` or `:desc`. |
| `--model <provider/model>` | OpenCode default | Override the OpenCode model selection. |
| `--thinking <variant>` | OpenCode default | OpenCode model variant (for example `low`, `medium`, `high`). |
| `--grounding-thinking <variant>` | `low` | Model variant for issue grounding/readiness. |
| `--implementation-thinking <variant>` | `high` | Model variant for implementation sessions, independent of the global variant. |
| `--implementation-attempts <count>` | `3` | Positive number of implementation attempts allowed when sessions leave an unresolved empty diff. |
| `--implementation-fallback-model <provider/model>` | none | Optional model used after the first unresolved empty implementation attempt. |
| `--complexity-thinking <variant>` | `medium` | Model variant for complexity routing. |
| `--review-thinking <variant>` | `high` | Model variant for staged-change reviews. |
| `--commit-thinking <variant>` | `low` | Model variant for commit-message generation. |
| `--verify-command <command>` | discovered `bun run check` | Deterministic verification command; repeat to run multiple commands in order. Each command runs under a 30-minute deadline. |
| `--max-attempts <count>` | `3` | Positive pipeline attempt count in `get-pipelines-green` mode. |
| `--pipeline-timeout <duration>` | `30m` | Positive integer duration (`s`, `m`, or `h`) for `get-pipelines-green` mode; this is the total pipeline-run deadline. |
| `--opencode-url <url>` | discovered service | OpenCode server URL (defaults to the local background service). |
| `--opencode-token <token>` | service auth | OpenCode server token (defaults to background-service auth). |
| `--workspace <path>` | `~/.ralphie` | Root directory for repository checkouts and run artifacts. |
| `--dry-run` | off | Preview the selected mode. Issue mode assesses/routes, maintenance mode plans, and pipeline mode observes/diagnoses without agent or delivery mutations. |
| `--resume <state.json>` | none | Continue a compatible saved run. |
| `--clean <when>` | off | Remove the workspace at `start`, `end`, or `both` (before any step and/or after success). |
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

The `maintain-issues` mode accepts shared issue selection options and uses
`--duplicate-action link` by default; `close` is also accepted. Its maintenance
executor is a bounded one-shot pass: it captures one selected open-issue
snapshot, asks a read-only OpenCode planner for a schema-validated plan, and
reconciles allowed labels/comments/relationships through deterministic GitHub
services after live revalidation. It never runs issue implementation,
decomposition, commit/push, pull-request delivery, or completed closure. Issue
workflow and implementation-only options are rejected in this mode. See the
[maintenance execution trace](end-to-end-execution.md#maintenance-mode) for
the action, safety, and recovery contract.

Use `--duplicate-action close` only when the operator accepts the additional
issue-closure risk. The default `link` policy leaves both duplicate candidates
open; `close` links first, reconciles the existing `duplicate` label, and then
closes only the proven duplicate after the live issue pair is rechecked. A
non-dry-run pass stores separate maintenance state at
`<workspace>/.ralphie/runs/<run-id>/state.json`; resume with
`--resume <state.json>`. A maintenance dry run performs read-only observation,
planning, validation, and reporting without workspace preparation, GitHub
mutation, state-file, artifact, or event-log writes.

The `get-pipelines-green` mode is selected explicitly and keeps its retry and
deadline settings separate from issue options. It operates on one selected
base branch, not an issue queue:

```bash
bunx @beremaran/ralphie owner/repository --mode get-pipelines-green \
  --max-attempts 3 --pipeline-timeout 10m
```

When `--branch` is omitted, the runner selects `main` when it exists and then
falls back to `master`. `--max-attempts` defaults to `3` and counts only
repairs whose new commit is confirmed on the remote. `--pipeline-timeout`
defaults to `30m` and accepts exactly a positive integer followed immediately
by one suffix: `s` (seconds), `m` (minutes), or `h` (hours). For example,
`30s`, `10m`, and `2h` are valid; `0`, decimals, spaces, and compound values
are rejected. The deadline is absolute across observation, OpenCode repair,
verification, commit, push, reconciliation, and final proof, including after
resume.

Pipeline mode reads Check Runs, Check Suites, legacy commit statuses, and
Actions workflow runs for the exact remote commit SHA. It normalizes each
visible context to `passing`, `acceptable` (neutral or skipped), `pending`,
`failing`, `cancelled`, or `unknown`. Exit `0` requires at least one complete
item, every item `passing`, no source/completeness errors, and a final remote
HEAD read equal to the observed SHA. An empty result after the bounded
registration-grace policy is `no-pipelines-discovered`; pending work waits
until its deadline, and neutral/skipped, cancelled, unknown, or failing work
is non-green. The observer also supports a quiescence window and repeated
stable terminal confirmations; the top-level CLI uses the current defaults
unless an embedding caller supplies different observer settings.

Pipeline mode accepts shared options such as `--branch`, `--workspace`,
`--model`, `--thinking`, `--output`, `--dry-run`, `--resume`, and `--clean`.
Issue-queue, maintenance, and issue-agent flags are incompatible: this
includes `--workflow`, `--max-issues`, `--issue-label`, `--issue-sort`,
`--max-decomposition-depth`, `--on-needs-attention`,
`--on-issue-failure`, `--notify-needs-attention`, `--needs-attention-label`,
`--verify-command`, the issue stage-thinking flags, `--implementation-attempts`,
`--implementation-fallback-model`, and `--duplicate-action`.

The pipeline runner never scrapes a browser page, reruns an Actions workflow,
force-pushes, creates a pull request, or asks OpenCode to commit or push. A
failing snapshot is diagnosed through bounded, terminal-sanitized evidence and
then repaired only inside the deterministic Git/checkpoint protocol. CI values
are untrusted evidence, not instructions. The run state and diagnostics are
kept at `<workspace>/.ralphie/runs/<run-id>/pipeline/state.json` and
`<workspace>/.ralphie/runs/<run-id>/pipeline/diagnostics.json`; failed and
cancelled runs remain available for `--resume`.

## Environment variables

Model credentials are read from environment variables:

| Variable | Purpose |
| --- | --- |
| `GH_TOKEN` | GitHub.com token for noninteractive `gh` authentication (preferred). |
| `GITHUB_TOKEN` | Fallback GitHub.com token alias for `gh`. |
| `OPENCODE_URL` | OpenCode server URL (used when `--opencode-url` is absent). |
| `OPENCODE_TOKEN` | OpenCode server token; supply it only through the environment. |

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
discovers issues, and asks OpenCode for a complexity decision. It may create or reset
the local workspace and write run artifacts, but it does not ask OpenCode to edit the
repository, create commits, push, or mutate GitHub.

```bash
bunx @beremaran/ralphie owner/repository --dry-run --max-issues 1
```

### Configure a run with CLI flags

```bash
bunx @beremaran/ralphie owner/repository \
  --workflow pr \
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

Require multiple labels and let OpenCode choose its configured model:

```bash
bunx @beremaran/ralphie owner/repository \
  --issue-label bug \
  --issue-label backend
```

Select a OpenCode model and thinking level explicitly:

```bash
bunx @beremaran/ralphie owner/repository \
  --model openai/gpt-5 \
  --thinking high
```

Use lower reasoning for routing and commit text while retaining a stronger
review, and override the deterministic project gate when needed:

```bash
bunx @beremaran/ralphie owner/repository \
  --grounding-thinking low \
  --complexity-thinking medium \
  --review-thinking high \
  --commit-thinking low \
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

### Observe and repair a base-branch pipeline

Start with the mutation-free preview. It authenticates, prepares/inspects the
checkout, observes the exact current remote HEAD, waits and classifies visible
checks, and collects diagnostics for a failure. It does not start OpenCode or
mutate Git, GitHub, Actions, or pull requests:

```bash
bunx @beremaran/ralphie owner/repository \
  --mode get-pipelines-green --branch main --dry-run \
  --pipeline-timeout 10m --output verbose
```

Run the direct repair workflow after inspecting the preview:

```bash
bunx @beremaran/ralphie owner/repository \
  --mode get-pipelines-green --branch main \
  --max-attempts 3 --pipeline-timeout 30m
```

Use JSON Lines for a scheduler or an audit consumer:

```bash
bunx @beremaran/ralphie owner/repository \
  --mode get-pipelines-green --branch main --output json \
  > pipeline-progress.jsonl
```

On a failure or cancellation, resume with the pipeline state path reported by
the run:

```bash
bunx @beremaran/ralphie owner/repository \
  --mode get-pipelines-green --branch main \
  --resume ~/.ralphie/.ralphie/runs/<run-id>/pipeline/state.json
```

Resume re-reads the remote branch, invalidates stale evidence, and reconciles
a push whose response was lost. It never restarts the saved total deadline or
duplicates a confirmed push. Ordinary non-green outcomes exit `1`; a caller
interrupt exits `130`; only a green final current-HEAD proof exits `0`.

### Run the issue pipeline

The top-level `--mode` defaults to `issues`:

```bash
bunx @beremaran/ralphie owner/repository --max-issues 5
```

The default `lgtm` workflow commits and pushes directly to the selected branch.
The `pr` workflow creates and pushes a feature branch, opens or reuses a
matching pull request, publishes the automated review attempts, waits for
every check on the exact head SHA to pass, and then merges only while the
head is unchanged. It is not a wait-for-human-review mode. A gate that
fails, times out, sees no pipelines, or finds the head changed retains the
feature branch and pull request and persists resumable state instead of
merging or closing. The pull request body links the source issue with
`Closes #<issue>` so GitHub closes the issue automatically when the pull
request is merged:

```bash
bunx @beremaran/ralphie owner/repository --workflow pr
```

Read [Workflows](workflows.md) and [Safety](safety.md) before running these
mutation-enabled examples.

## Version and help

`ralphie --version` prints only the release version. For automation,
`ralphie --version --output json` prints a stable object containing `version`
and `commitSha`. Both forms work without a repository, GitHub credentials, or
OpenCode server. Release builds embed the immutable commit SHA supplied by
the build entry point; local builds use the documented `local` commit sentinel
when no release SHA is supplied.
