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
- model credentials for [pi](https://pi.dev/docs/latest).

The pi agent runtime runs in-process; there is no server to start. Credentials
resolve through the same `~/.pi/agent/auth.json` that the `pi` CLI uses
(override the directory with `PI_CODING_AGENT_DIR`). If you already signed in
with `pi /login`, Ralphie reuses that credential. Otherwise export a provider
API key such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`; a
stored pi credential takes priority over the environment.

Without `--model`, Ralphie uses the default model saved in pi's
`~/.pi/agent/settings.json` (`defaultProvider` plus `defaultModel`). Select one
explicitly with `--model provider/model`; the pi provider catalog is built in
and available offline.

Ralphie constrains every agent session to the repository checkout. Built-in
`read`/`write`/`edit` tools are rooted at the checkout, `bash` commands that
mutate delivery state (`git commit/push/branch/checkout/switch/worktree/reset/clean`
and `gh *`) are denied before execution, and post-task verification fails the
task when the checkout was mutated anyway.

For interactive GitHub authentication, run `gh auth login` and verify the
selected account with `gh auth status`. For unattended runs, set `GH_TOKEN`
(preferred) or `GITHUB_TOKEN` (fallback) in the process environment. The
credential is supplied as an input and does not need to be printed or exposed;
a mounted GitHub CLI profile is not required when an environment token is
provided. This contract covers `github.com` only.

Permission needs depend on the run. The issue workflow needs
read access to the target repository and its issues, permission to push to the
selected branch, and permission to create, update, and close issues.

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

Deterministic verification is opt-in. Provide one or more
`--verify-command` values to run the target's checks in the checkout through
`/bin/sh` after changes are staged; when omitted, the gate is skipped and
review proceeds on the staged diff alone. The tools used by a supplied command
belong to the target repository's contract, not Ralphie's runtime: a command
that uses Bun, Node.js, or a project compiler needs those tools present in the
environment you run Ralphie in.

## First run

Run against one issue in a repository you control:

```bash
bunx @beremaran/ralphie owner/repository
```

When running from source, use the source entry point instead:

```bash
bun run index.ts owner/repository
```

This performs authentication and Git preflight, prepares a clean checkout,
discovers issues, and asks pi to ground, implement, verify, and commit the
work. Successful delivery pushes directly to the selected branch and closes the
issue. See [Workflows](workflows.md) for what the selected route means and
[Operations and recovery](operations-and-recovery.md)
for the artifacts it leaves behind.

For all available options and mode-specific commands, continue to the [CLI
reference](cli-reference.md).