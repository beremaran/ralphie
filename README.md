# ralphie

An early-stage CLI for running an OpenCode workflow against a GitHub repository,
built with [Bunli](https://bunli.dev/) and [Effect](https://effect.website/).

## Setup

```bash
bun install
```

The CLI also requires these local tools:

- [GitHub CLI](https://cli.github.com/), authenticated with `gh auth login`
- [Git](https://git-scm.com/)
- [OpenCode](https://opencode.ai/), available as `opencode` on `PATH`

## Usage

```bash
bun run index.ts <repo> [--branch <branch>] [--max-issues <count>] [--issue-label <label>] [--issue-sort <sort>] [--issue-order <order>] [--workspace <path>] [--start-clean] [--cleanup]
# Example:
bun run index.ts owner/project --branch develop --max-issues 10 --issue-label bug --issue-sort created --issue-order asc --workspace /tmp/ralphie --start-clean --cleanup
```

The branch defaults to `main`. The short form `-b develop` is also supported.
By default, Ralphie processes an unlimited number of issues. Pass a positive
integer to `--max-issues` to set a limit.
Use repeatable `--issue-label` flags to require labels when selecting issues.
Issues can be sorted with `--issue-sort created|updated|comments` and
`--issue-order asc|desc`; the defaults select the oldest-created issue first.
The workspace defaults to `~/.ralphie`. Pass `--workspace <path>` to choose a
different location for cloned repositories and working files.
Pass `--cleanup` to remove the workspace after a successful run. Cleanup is
skipped when the workflow fails and refuses protected paths such as `/`, your
home directory, or the current project directory.
Pass `--start-clean` to remove an existing workspace before any other workflow
work begins. It uses the same protected-path checks as `--cleanup`.

The current scaffold validates GitHub CLI authentication, retrieves its token to
initialize Octokit, and verifies the Git installation. It then clones the target
repository into `<workspace>/<repository>` (or safely reuses a matching existing
checkout), fetches it, switches to the requested branch when necessary, and starts
an OpenCode server before exiting. Before OpenCode starts, Ralphie fetches every
matching open GitHub issue, reports the count, and identifies the first issue it
would process. Existing dirty checkouts are reset to the
requested remote branch with `git reset --hard` and `git clean -fd`, discarding
tracked and untracked local changes.

## Development

```bash
bun test
bun run typecheck
bun run build
bun run probe:structured-output
```

The structured-output probe starts a temporary OpenCode server, asks a small
decision question with a Zod-generated JSON Schema, validates the returned value
against that same schema, prints it, and closes the server. The reusable adapter
in `src/opencode/structured-output.ts` will underpin typed agent decisions in the
issue pipeline.

Bunli owns command routing, options, validation, help, and executable builds.
The workflow and its external integrations are modeled as Effect programs and
layers, including guaranteed cleanup of the temporary OpenCode server.

## Architecture

Functionality is grouped by domain under `src/`:

- `github/` owns GitHub CLI authentication and Octokit initialization.
- `git/` owns repository cloning, validation, cleanup, and branch preparation.
- `issues/` owns issue selection and the per-issue execution pipeline.
- `opencode/` owns the OpenCode server lifecycle and schema-validated decisions.
- `workspace/` owns workspace path resolution and safe removal.
- `process/` owns external command execution.
- `shared/` contains errors shared across domains.

`workflow.ts` orchestrates these domain services, while `runtime.ts` assembles
their live Effect layers.

The issue pipeline currently prepares a typed sequence for each selected issue:
deterministic Git branch preparation, a GitHub status action, separate planning
and implementation OpenCode sessions, Git validation and commit tasks, and a
final GitHub publication action. Stage execution will be implemented next.
