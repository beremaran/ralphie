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
bun run index.ts <repo> [--branch <branch>] [--max-issues <count>]
# Example:
bun run index.ts owner/project --branch develop --max-issues 10
```

The branch defaults to `main`. The short form `-b develop` is also supported.
By default, Ralphie processes an unlimited number of issues. Pass a positive
integer to `--max-issues` to set a limit.

The current scaffold validates GitHub CLI authentication, retrieves its token to
initialize Octokit, verifies the Git installation, starts an OpenCode server,
reports that it is ready, and then shuts the server down before exiting.
Repository workflow functionality will be added later.

## Development

```bash
bun test
bun run typecheck
bun run build
```

Bunli owns command routing, options, validation, help, and executable builds.
The workflow and its external integrations are modeled as Effect programs and
layers, including guaranteed cleanup of the temporary OpenCode server.
