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

> [!WARNING]
> Ralphie lets implementation agents edit files in the target checkout, then
> commits and pushes approved changes directly to `--branch`. It does not create
> a protective worktree, feature branch, or pull request. Use it only where you
> accept those mutations.

```bash
bun run index.ts <repo> [--branch <branch>] [--agent <agent>] [--model <provider/model>] [--model-variant <variant>] [--max-issues <count>] [--issue-label <label>] [--issue-sort <sort>] [--issue-order <order>] [--workspace <path>] [--verbose] [--json|--quiet] [--resume <state.json>] [--start-clean] [--cleanup]
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
integer to `--max-issues` to set a limit. The budget is charged when work on an
issue begins and is retained when decomposition refreshes the queue with child
issues.
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
Pass `--resume <state.json>` to continue an interrupted run. The saved
repository and branch must match the command, and Ralphie reconciles the saved
queue with the current checkout and open GitHub issues before doing more work.

Ralphie validates GitHub CLI authentication, initializes Octokit from the local
`gh` token, verifies Git, and prepares `<workspace>/<repository>`. A matching
existing checkout is fetched, switched to the requested branch, and cleaned with
`git reset --hard` and `git clean -fd`; tracked and untracked local changes are
discarded. Ralphie then starts one OpenCode server and processes matching issues
through the workflows below. One issue failure currently halts the run and leaves
resumable state and diagnostics in place.

## Workflows and recovery

Every issue first receives a schema-validated complexity score from 0 through 5.

- Complexity 0–3 runs implementation in a fresh session, stages changes with
  Git, and asks a separate session to review the exact staged diff. Requested
  changes are addressed in another fresh session. After at most five reviews,
  an approved diff receives a structured commit message and is committed and
  pushed directly to the selected branch. A successful agent that makes no
  changes is recorded as skipped.
- Complexity 4–5 is decomposed into independently actionable child issues.
  Ralphie creates them in deterministic order, adds parent, sibling, dependency,
  and lineage links, rewrites the original issue, and closes it as a duplicate.
  The open-issue queue is then refreshed so eligible children can run in the
  same invocation.

If five reviews cannot converge, Ralphie first writes the staged binary patch,
review decisions, and session metadata to the run diagnostics. It restores the
exact clean issue checkpoint and routes the original issue into decomposition.
If diagnostics cannot be preserved or the restore cannot be verified, the run
halts without continuing on an uncertain checkout. GitHub decomposition uses
stable markers and persists child mappings so retries discover existing children
and resume linking instead of creating duplicates.

## Progress, state, and diagnostics

Human progress is written to stderr; `--json` writes one JSON object per line to
stdout. JSON events contain `runId`, `timestamp`, `stage`, `status`, and `message`,
with optional `issue`, `current`, `total`, `attempt`, `maxAttempts`, and `details`.
Stage and status strings are a versioned operational vocabulary; fields may only
be added compatibly within a minor release. Sensitive tokens and environment
values are redacted at the renderer boundary. Session IDs, commit SHAs, created
issue numbers, and diagnostic paths are confined to JSON or verbose details.

Run state is written atomically to
`<workspace>/.ralphie/runs/<run-id>/state.json`. Per-issue diagnostics live under
the same run directory. Failed and interrupted runs retain that directory for
inspection and `--resume`. A successful run is marked complete before optional
`--cleanup`; cleanup removes the whole workspace, including completed state and
diagnostics. Use a workspace you are willing to delete when enabling cleanup.

## Development

```bash
bun test
bun run typecheck
bun run build
bun run check
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

The issue loop works directly on `--branch`; it does not create issue branches,
worktrees, pull requests, or force pushes. Its refreshable queue deduplicates
newly created issues, respects dependency completion and configured sorting, and
retains the `--max-issues` budget across refreshes and resume.

## Packaging and releases

`bun run build` creates a standalone executable for the current platform in
`dist/`. For source installs, clone the repository, run `bun install
--frozen-lockfile`, and invoke `bun run index.ts`; contributors can also use
`bun link` to expose the package's `ralphie` binary locally.

Ralphie uses Semantic Versioning. Until 1.0, minor releases may contain breaking
CLI or state-schema changes and patch releases remain backward compatible. Each
release updates `CHANGELOG.md`, passes `bun run check`, and publishes checksummed
platform binaries from a signed Git tag.
