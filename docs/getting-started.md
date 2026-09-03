# Getting started

This page is for a new operator setting up Ralphie and performing the first
safe validation. It is the authoritative guide to prerequisites, installation,
credential setup, verification, and the first dry run. Return to the
[documentation index](README.md) for other task paths.

> [!CAUTION]
> Ralphie defaults to the `lgtm` workflow, which commits approved work and
> pushes directly to the selected branch. Ralphie is pre-1.0. The commands on
> this page use `--dry-run`; read the [safety model](safety.md) before enabling
> mutations.

## Prerequisites and authentication

Ralphie is distributed as a single npm package. Running it needs:

- [Bun](https://bun.sh/) (also needed to build from source);
- [Git](https://git-scm.com/) and the
  [GitHub CLI](https://cli.github.com/) (`gh`);
- a POSIX shell;
- a running [OpenCode](https://opencode.ai/v2/docs/) server (`opencode2 serve`).

Ralphie never starts the OpenCode server itself. Start it separately before
running Ralphie (for example `opencode2 serve`), then point Ralphie at it.
By default Ralphie discovers the local background service automatically. To
use an explicit server, pass `--opencode-url <url>` (or set `OPENCODE_URL`)
and, when the server requires one, `--opencode-token <token>` (or set
`OPENCODE_TOKEN` in the environment).

The OpenCode server owns model credentials and tool permissions. For
unattended runs, configure its permissions to allow `read`, `edit`, and
`shell` work inside the checkout while denying mutating Git and GitHub
commands (`git commit/push/branch/checkout/switch/worktree/reset/clean` and
`gh *`). Ralphie additionally instructs agents never to run those commands,
auto-rejects them when they surface as pending approvals, and fails the task
when post-task verification finds the checkout was mutated anyway.

For interactive GitHub authentication, run `gh auth login` and verify the
selected account with `gh auth status`. For unattended runs, set `GH_TOKEN`
(preferred) or `GITHUB_TOKEN` (fallback) in the process environment. The
credential is supplied as an input and does not need to be printed or exposed;
a mounted GitHub CLI profile is not required when an environment token is
provided. This contract covers `github.com` only.

Your GitHub account must be able to read the target repository and its issues.
Non-dry runs also require permission to push to the selected branch and create,
update, and close issues. `--workflow pr` additionally requires permission to
create, comment on, and merge pull requests.

## Installation

### Published package

Use Bun's package runner to run the latest published version without a global
installation:

```bash
bunx @beremaran/ralphie --version
```

For a global install, `bun add -g @beremaran/ralphie` provides the `ralphie`
command. The `@beremaran` scope is intentional. Do not substitute the unrelated
unscoped npm package named `ralphie`; use `@beremaran/ralphie` for this CLI.

### Source checkout

For development or to run the current checkout:

```bash
git clone https://github.com/beremaran/ralphie.git
cd ralphie
bun install --frozen-lockfile
bun run index.ts --version
```

## Verify the installation

For the published package (Bun required):

```bash
bunx @beremaran/ralphie --version
git --version
gh --version
gh auth status
```

For a source checkout, use the source entry point instead (Bun required):

```bash
bun run index.ts --version
```

`ralphie --version` prints only the release version. For automation,
`ralphie --version --output json` prints a stable object containing `version`
and `commitSha`. Both forms work without a repository, GitHub credentials, or
OpenCode configuration. Release builds embed the immutable commit SHA supplied by
the build entry point; local builds use the documented `local` commit sentinel
when no release SHA is supplied.

## Target-repository verification dependencies

Ralphie runs deterministic verification commands in the target checkout through
`/bin/sh`. If the target has a `package.json` `check` script, Ralphie defaults
to `bun run check`; otherwise provide one or more `--verify-command` values.
The tools used by that command belong to the target repository's contract, not
Ralphie's runtime: a target whose check uses Bun, Node.js, or a project
compiler simply needs those tools present in the environment you run Ralphie
in.

## First dry run

Preview one issue in a repository you control:

```bash
bunx @beremaran/ralphie owner/repository --dry-run --max-issues 1
```

When running from source, use the source entry point instead:

```bash
bun run index.ts owner/repository --dry-run --max-issues 1
```

This performs authentication and Git preflight, prepares a clean checkout,
discovers issues, and asks OpenCode for read-only grounding and a complexity
assessment. It may create or reset the local workspace and write run
artifacts, but it does not ask OpenCode to edit the repository, create commits, push,
or mutate GitHub. Dry-run also reports already-resolved and needs-attention
routes, then remains mutation-free on resume. See [Workflows](workflows.md) for
what the selected route means and [Operations and recovery](operations-and-recovery.md)
for the artifacts it leaves behind.

For all available options and mode-specific commands, continue to the [CLI
reference](cli-reference.md).