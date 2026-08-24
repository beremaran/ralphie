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
bun run index.ts <repo> [--branch <branch>]
# Example:
bun run index.ts owner/project --branch develop
```

The branch defaults to `main`. The short form `-b develop` is also supported.

The current scaffold validates GitHub CLI authentication and the Git installation,
starts an OpenCode server, reports that it is ready, and then shuts the server down
before exiting. Repository workflow functionality will be added later.

## Development

```bash
bun test
bun run typecheck
bun run build
```

Bunli owns command routing, options, validation, help, and executable builds.
The workflow and its external integrations are modeled as Effect programs and
layers, including guaranteed cleanup of the temporary OpenCode server.
