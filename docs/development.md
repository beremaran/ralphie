# Development

This page is for contributors and maintainers working on the Ralphie checkout.
It is the authoritative home for local setup, validation commands, network smoke
tests, and contribution expectations. Return to the [documentation
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
| `bun run test` | Run the unit and disposable integration test suite. |
| `bun run typecheck` | Type-check without emitting JavaScript. |
| `bun run format` | Format the repository with Biome. |
| `bun run format:check` | Verify formatting without modifying files. |
| `bun run lint` | Check TypeScript cognitive complexity (maximum 12). |
| `bun run build` | Build the standalone executable at `dist/cli` (local builds use the `local` commit sentinel). |
| `bun run build -- --commit-sha <sha> [--version <version>]` | Build with explicit release metadata. |
| `bun run build:package` | Build the publishable package bundle at `dist/ralphie.js`. |
| `bun run package:check` | Pack, inspect, install, and run the local package in isolated temporary directories. |
| `bun run package:inspect` | Inspect the local `npm pack --dry-run` file list without installing it. |
| `bun run package:stage -- --version <version> --commit-sha <sha> --output-dir <dir>` | Build and validate release package and installer staging inputs without publishing. |
| `env -u GH_TOKEN -u GITHUB_TOKEN bun run verify:public-distribution` | Verify the public repository, release assets, installer, formula, OCI image, and license anonymously (requires `sigstore`). |
| `bun run probe:structured-output` | Exercise a real schema-validated Pi decision. |

The package check builds an actual tarball, verifies its allowlist, installs it
with `npm install --omit=dev` in a fresh project, and invokes the installed bin
with Bun. Its isolated install does not use the checkout's lockfile or `node_modules`;
all temporary pack, install, cache, and home directories are created outside the
checkout. `package:stage` is the release handoff: it verifies the exact source
revision, builds with explicit version and commit metadata, packs the scoped
package with scripts disabled, and stages only the versioned tarball plus the
exact `scripts/install.sh` under stable contract paths.
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

## Network smoke tests

Real network integrations are opt-in and skipped by the normal test suite:

```bash
RALPHIE_RUN_PI_COMPLEXITY_SMOKE=1 \
  bun test tests/integration/network-smoke.test.ts

RALPHIE_RUN_PI_IMPLEMENTATION_SMOKE=1 \
  bun test tests/integration/network-smoke.test.ts

RALPHIE_RUN_GITHUB_INTEGRATION=1 \
RALPHIE_GITHUB_TEST_REPOSITORY=owner/ralphie-smoke-test \
  bun test tests/integration/network-smoke.test.ts

RALPHIE_RUN_GITHUB_SUB_ISSUES_SMOKE=1 \
RALPHIE_GITHUB_TEST_REPOSITORY=owner/ralphie-smoke-test \
  bun test tests/integration/network-smoke.test.ts
```

The GitHub smoke test is read-only and refuses repository names that do not look
like dedicated test, sandbox, fixture, integration, or smoke repositories.
Model selection can be supplied with `RALPHIE_PI_SMOKE_MODEL`,
`RALPHIE_PI_SMOKE_AGENT`, and `RALPHIE_PI_SMOKE_VARIANT`.

The sub-issues smoke test is **mutating** in the configured sandbox repository:
it creates three scratch issues, attaches native sub-issues, adds a
`blocked_by` dependency, verifies idempotency, closes the children, reconciles
the tracking parent as `completed`, and cleans up after itself. It requires a
host with the native sub-issues and dependencies endpoints and a token with
issue write permission.

The normal `bun run test` suite includes local end-to-end tests that build
temporary Git repositories with a stubbed Pi client; they do not need network
access or credentials.

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

Use the existing tests as patterns for Git and GitHub mutation paths. Do not
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
- versioning and publishing: [Releases](releases.md).

Keep the [end-to-end execution trace](end-to-end-execution.md) synchronized
when source-level sequencing changes, and update the [documentation index](README.md)
when pages or reading paths change.
