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
`format:check`, `lint`, `typecheck`, the source-reachability audit, `test`, and
`build`.

Useful individual commands:

| Command | Purpose |
| --- | --- |
| `bun run test` | Run the full Bun test suite, including offline unit tests, local integration/PTY coverage, and in-memory GitHub clients and stubs. The suite does not require live GitHub, model-provider, or registry credentials; some tests use temporary checkouts and local subprocesses. |
| `bun run typecheck` | Type-check without emitting JavaScript. |
| `bun run format` | Format the repository with Biome. |
| `bun run format:check` | Verify formatting without modifying files. |
| `bun run lint` | Check TypeScript cognitive complexity (maximum 12). |
| `bun run build` | Build the publishable package bundle at `dist/ralphie.js` (local builds use the `local` commit sentinel). |
| `bun run build -- --commit-sha <sha> [--version <version>]` | Build with explicit release metadata. |
| `bun run build:package` | Same as `bun run build`; the package bundle at `dist/ralphie.js`. |
| `bun run package:check` | Pack, inspect, install, and run the local package in isolated temporary directories. |
| `bun run package:inspect` | Inspect the local package-manager pack file list without installing it. |
| `bun run source:audit` | Run the deterministic, offline source/module/export reachability audit as sorted JSON. |

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

## Source reachability boundary

The supported runtime boundary is the bundled `dist/ralphie.js` CLI reached
from `index.ts` through `src/cli.ts`, `src/command.ts`, and the runtime
assembly. Tests and helper probes are verification-only consumers: they do not
establish a supported production path, and a type-only import does not
establish runtime bundle reachability.

`bun run source:audit` follows value imports, type-only imports, relative
re-exports, and missing paths from the production root `index.ts`. It also
follows the explicit build root `scripts/build.ts`, reports every `src/**/*.ts`
module and export in stable JSON, and fails on unresolved relative paths. Run
`bun run scripts/source-reachability.ts` when a human-readable classification
listing is more useful. The audit is part of `bun run check` and is fully
offline.

The completed audit has one intentional build-time exception set:

| Source path | Root | Import kind | Purpose |
| --- | --- | --- | --- |
| `scripts/build.ts` → `src/build-info.ts` | `scripts/build.ts` | value: `LOCAL_BUILD_COMMIT_SHA` | Supplies the `local` commit sentinel when a release build does not provide an explicit commit SHA. |
| `scripts/build.ts` → `src/build-info.ts` | `scripts/build.ts` | type: `BuildInfo` | Checks the shape of the version/commit metadata injected into the bundle. |
| `src/command.ts` → `src/build-info.ts` | `index.ts` production path | value: `BUILD_INFO` | Supplies the version and commit SHA reported by the CLI's plain and JSON `--version` output. |
| `src/build-info.ts` → `package.json` | `index.ts` production path and build output | value: package metadata | Provides the package version fallback used before release metadata is injected. |

Keep these roots and exceptions synchronized with the audit when changing the
source map or build metadata relationship. A source-only helper should not be
made part of the package boundary merely to satisfy a test import; add focused
verification at the canonical production seam instead.

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
not contact GitHub, model providers, npm, or a container registry.
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
run the mutating CLI against an uncontrolled repository while developing; use a
repository you control when a command-level check is needed. Ralphie removes the
selected workspace recursively before and after successful runs, so keep it
dedicated and disposable; see [Safety](safety.md).

## Where future documentation belongs

Do not append detailed contracts to the root README. Keep the root page as the
landing page, and place changes in the page that owns the fact:

- CLI options and recipes: [CLI reference](cli-reference.md);
- routing and delivery behavior: [Workflows](workflows.md);
- mutation boundaries: [Safety](safety.md);
- output, state, and recovery: [Operations and recovery](operations-and-recovery.md);
- components and source locations: [Architecture](architecture.md); and
- versioning and publishing: [Development](development.md#publishing).

Update the [documentation index](README.md)
when pages or reading paths change.
