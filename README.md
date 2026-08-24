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
bun run index.ts <repo> [--branch <branch>] [--agent <agent>] [--model <provider/model>] [--model-variant <variant>] [--max-issues <count>] [--issue-label <label>] [--issue-sort <sort>] [--issue-order <order>] [--workspace <path>] [--verbose] [--json|--quiet] [--start-clean] [--cleanup]
# Example:
bun run index.ts owner/project --branch develop --model openai/gpt-5 --model-variant high --max-issues 10 --issue-label bug --issue-sort created --issue-order asc --workspace /tmp/ralphie --start-clean --cleanup
```

The branch defaults to `main`. The short form `-b develop` is also supported.
The OpenCode agent defaults to `build`; use `--agent <agent>` to override it.
Use `--model provider/model` and `--model-variant variant` to override OpenCode's
model selection. Neither has a default; when omitted, OpenCode chooses them.
Progress uses interactive spinners in a terminal and durable plain lines in CI
or redirected output. Pass `--verbose` to include event details, `--json` to
write JSON Lines events to stdout, or `--quiet` to show failures only. `--json`
and `--quiet` are mutually exclusive.
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
- `progress/` owns typed progress events and human, JSON, quiet, and test renderers.
- `workspace/` owns workspace path resolution and safe removal.
- `process/` owns external command execution.
- `shared/` contains errors shared across domains.

`workflow.ts` orchestrates these domain services, while `runtime.ts` assembles
their live Effect layers.

The issue pipeline works directly on `--branch`; it does not create issue
branches, worktrees, or pull requests. An OpenCode session first assigns a
schema-validated complexity from 0 to 5. Complexity 0-3 enters the implementation
workflow: implement, stage, review with structured output, and address review in
a fresh session until approval or five passes, then generate a structured commit
message, commit, and push. Complexity 4-5 enters the decomposition workflow:
generate a dependency-aware issue breakdown, create and cross-link the resulting
issues, then rewrite and close the original as a duplicate. Newly created issues
are intended to re-enter the main open-issue loop when stage execution is added.

Before implementation, Ralphie records the clean checkout branch and exact HEAD.
If the fifth review still requests changes, it saves the staged binary patch and
structured review history under `<workspace>/.ralphie/runs/<run-id>/`, restores
and verifies that exact issue base, and escalates the original issue to the
decomposition workflow. The refreshable issue queue deduplicates newly created
issues, respects dependency completion, and retains the `--max-issues` budget.
If diagnostics cannot be preserved, restoration does not begin; if restoration
fails, the run stops rather than continuing with a contaminated checkout.
