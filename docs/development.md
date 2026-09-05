# Development

This page is for contributors and maintainers working on the Ralphie checkout.
It is the authoritative home for local setup, validation commands, optional
registry checks, and contribution expectations. Return to the [documentation
index](README.md) for the other documentation paths.

## Local setup and checks

Install dependencies and run the complete local gate:

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` runs the same gate as CI, in this order:
`format:check`, `lint`, `typecheck`, `test`, and `build`.

Useful individual commands:

| Command | Purpose |
| --- | --- |
| `bun run test` | Run the full Bun test suite, including offline unit tests, local integration/PTY coverage, and in-memory GitHub clients and stubs. The suite does not require live GitHub, OpenCode, or registry credentials; some tests use temporary checkouts and local subprocesses. |
| `bun run typecheck` | Type-check without emitting JavaScript. |
| `bun run format` | Format the repository with Biome. |
| `bun run format:check` | Verify formatting without modifying files. |
| `bun run lint` | Check TypeScript cognitive complexity (maximum 12). |
| `bun run build` | Build the publishable package bundle at `dist/ralphie.js` (local builds use the `local` commit sentinel). |
| `bun run build -- --commit-sha <sha> [--version <version>]` | Build with explicit release metadata. |
| `bun run build:package` | Same as `bun run build`; the package bundle at `dist/ralphie.js`. |
| `bun run package:check` | Pack, inspect, install, and run the local package in isolated temporary directories. |
| `bun run package:inspect` | Inspect the local `npm pack --dry-run` file list without installing it. |
| `bun run probe:structured-output` | Exercise a real schema-validated OpenCode decision; `--union` probes the grounding decision union, and `--model provider/id`, `--agent`, `--variant` target a specific model. |

The package check builds an actual tarball, verifies its allowlist, installs it
with `npm install --omit=dev` in a fresh project, and invokes the installed bin
with Bun. Its isolated install does not use the checkout's lockfile or `node_modules`;
all temporary pack, install, cache, and home directories are created outside the
checkout.
For an explicitly opt-in registry check, pass a package spec:

```bash
bun run package:check -- \
  --registry --package-spec @beremaran/ralphie@<release-version>
```

The project is a Bun + TypeScript CLI in strict mode. The entry point is
`index.ts`; services are assembled as an explicit dependency object in
`src/runtime.ts`, and `src/workflow.ts` orchestrates them. Formatting is Biome
with four-space indentation, double quotes, and semicolons. Keep functions
small: the configured cognitive-complexity limit is the meaningful lint
constraint.

## Publishing

The package builds with `bun run build` to `dist/ralphie.js`; `bun run
package:check` packs, installs, and runs it in an isolated directory, and
`bun run package:inspect` lists the packed files. Release flow: bump
`package.json` `version` and `CHANGELOG.md`, push a `v<major>.<minor>.<patch>`
tag, and the tag-triggered publish workflow validates the tag/package version
(`scripts/validate-npm-context.ts`), builds, smoke-checks, and runs
`bun publish`. No other distribution channel exists.

The `bun run test` suite is deliberately offline: it combines fast in-memory
unit tests with local integration, PTY, and temporary-checkout coverage. It does
not contact GitHub, OpenCode, npm, or a container registry.
The former distribution-channel and live network smoke suites (standalone
installer, Docker image, Homebrew reconciliation, and release publication)
were removed from the default gate; the package registry check remains an
explicit opt-in using `--registry` with an exact `--package-spec`.

## Contribution expectations

Contributions are welcome. For substantial behavior or workflow changes, open
an issue first so the safety and recovery implications can be discussed before
implementation.

Before submitting a change:

1. Add or update tests for the behavior.
2. Run `bun run check`.
3. Keep Git and GitHub mutations inside their deterministic domain services.
4. Update the authoritative page under [`docs/`](README.md) when documentation
   changes. Update [`CHANGELOG.md`](../CHANGELOG.md) when the command surface or
   recovery contract changes.

Add in-memory unit tests for new behavior, following the patterns in the
remaining files under `tests/`. Do not
run the mutating CLI against an uncontrolled repository while developing; use
`--dry-run --max-issues 1` and a repository you control when a command-level
check is needed. Reusing a workspace can reset and clean that checkout, and
`--clean` can recursively delete it; see [Safety](safety.md).

## Where future documentation belongs

Do not append detailed contracts to the root README. Keep the root page as the
landing page, and place changes in the page that owns the fact:

- CLI options and recipes: [CLI reference](cli-reference.md);
- routing and delivery behavior: [Workflows](workflows.md);
- mutation boundaries: [Safety](safety.md);
- output, state, and recovery: [Operations and recovery](operations-and-recovery.md);
- components and source locations: [Architecture](architecture.md); and
- versioning and publishing: [Development](development.md#publishing).

Keep the [end-to-end execution trace](end-to-end-execution.md) synchronized
when source-level sequencing changes, and update the [documentation index](README.md)
when pages or reading paths change.
