# Getting started

This page is for a new operator setting up Ralphie and performing the first
safe validation. It is the authoritative guide to prerequisites, installation,
credential setup, verification, and the first run. Return to the
[documentation index](README.md) for other task paths.

> [!CAUTION]
> Ralphie commits approved work and pushes directly to the selected branch.
> Ralphie is pre-1.0. Validate against a repository you control and read the
> [safety model](safety.md) before enabling mutations.

## Prerequisites and authentication

Ralphie is distributed as a single npm package. Running it needs:

- [Bun](https://bun.sh/) (also needed to build from source);
- [Git](https://git-scm.com/) and the
  [GitHub CLI](https://cli.github.com/) (`gh`);
- a POSIX shell;
- at least one supported coding-agent command-line program, signed in: Claude
  Code (`claude`, the default), Codex (`codex`), pi (`pi`), or OpenCode
  (`opencode`).

Agent sessions run through that program, headless, in the repository
checkout. It brings its own login, so Ralphie asks for no model credentials
and stores none. Pick the harness, model and effort per role with the
`harnesses` and `roles` keys in the
[configuration file](configuration.md#harnesses-and-roles); without them every
role uses Claude Code with its own defaults. Sessions never commit, push, or
mutate GitHub; Ralphie's deterministic services do (see the
[safety model](safety.md#agent-and-mutation-boundaries)).

For interactive GitHub authentication, run `gh auth login` and verify the
selected account with `gh auth status`. For unattended runs, set `GH_TOKEN`
(preferred) or `GITHUB_TOKEN` (fallback) in the process environment. The
credential is supplied as an input and does not need to be printed or exposed;
a mounted GitHub CLI profile is not required when an environment token is
provided. This contract covers `github.com` only.

Ralphie only works on open issues labelled `ready-for-agent` (the label name
is configurable). Label at least one issue before the first run, or enable
[AFK triage](workflows.md#afk-triage).

Permission needs depend on the run. The issue workflow needs
read access to the target repository and its issues, permission to push to the
selected branch, and permission to create, update, and close issues.

## Create the config file

Run `ralphie init` once. It looks for the supported harnesses (`claude`,
`codex`, `pi`, `opencode`) on PATH and writes a commented config file at the
default location (or at `--config <path>`), assigning the first harness it
finds to every role. The defaults pass the startup checks for the harnesses it
found. It refuses to overwrite an existing file and fails when no harness is
installed. Running Ralphie without a config file points you back to `init`.

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
model configuration. Release builds embed the immutable commit SHA supplied by
the build entry point; local builds use the documented `local` commit sentinel
when no release SHA is supplied.

## Target-repository verification dependencies

Deterministic verification is opt-in. List one or more
commands under `repos."owner/repo".verify` in the
[configuration file](configuration.md) to run the target's checks in the checkout through
`/bin/sh` after changes are staged; when omitted, the gate is skipped and
review proceeds on the staged diff alone. The tools used by a supplied command
belong to the target repository's contract, not Ralphie's runtime: a command
that uses Bun, Node.js, or a project compiler needs those tools present in the
environment you run Ralphie in.

## First run

Run against the `ready-for-agent` issues of a repository you control:

```bash
bunx @beremaran/ralphie owner/repository
```

When running from source, use the source entry point instead:

```bash
bun run index.ts owner/repository
```

This performs authentication and Git preflight, prepares a clean checkout,
discovers issues, and asks the configured harness to pre-flight, implement, review, and commit the
work. Successful delivery pushes directly to the selected branch and closes the
issue. See [Workflows](workflows.md) for what the selected route means and
[Operations and recovery](operations-and-recovery.md)
for the artifacts it leaves behind.

For all available options, continue to the [CLI reference](cli-reference.md).