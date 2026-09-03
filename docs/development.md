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
| `bun run test` | Run the unit test suite: ~130 fast, in-memory tests across 9 files (CLI surface, workflow orchestration, runtime assembly, safety, and a GitHub-issue/pipeline slice). No network, no process spawns, no temporary repositories. |
| `bun run typecheck` | Type-check without emitting JavaScript. |
| `bun run format` | Format the repository with Biome. |
| `bun run format:check` | Verify formatting without modifying files. |
| `bun run lint` | Check TypeScript cognitive complexity (maximum 12). |
| `bun run build` | Build the standalone executable at `dist/cli` (local builds use the `local` commit sentinel). |
| `bun run build -- --commit-sha <sha> [--version <version>] [--target <darwin-arm64, darwin-x64, linux-arm64, linux-x64>]` | Build with explicit release metadata; `--target` selects the Bun native compiler target. |
| `bun run build:package` | Build the publishable package bundle at `dist/ralphie.js`. |
| `bun run package:check` | Pack, inspect, install, and run the local package in isolated temporary directories. |
| `bun run package:inspect` | Inspect the local `npm pack --dry-run` file list without installing it. |
| `bun run package:stage -- --version <version> --commit-sha <sha> --output-dir <dir>` | Build and validate release package and installer staging inputs without publishing. |
| `env -u GH_TOKEN -u GITHUB_TOKEN bun run verify:public-distribution` | Verify the public repository, release assets, installer, formula, OCI image, and license anonymously (requires `sigstore`). |
| `bun run probe:structured-output` | Exercise a real schema-validated Pi decision; `--union` probes the grounding decision union, and `--model provider/id`, `--agent`, `--variant` target a specific model. |
| `bun run targets -- <mode>` | Query, generate, or byte-check release target documents over `targets/standalone-targets.json`; see the standalone targets command below. |

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

## Standalone targets command

`bun run targets` (backed by `scripts/standalone-targets.ts`) is a
credential-free, repository-side-effect-free command over the canonical
release target manifest `targets/standalone-targets.json`. Use `--manifest
<path>` to point it at a fixture for isolated tests; otherwise the canonical
manifest is loaded, parsed, and exact-target-validated in full before any
output exists.

```bash
bun run targets -- query --id <stable-id>
bun run targets -- query --os <os> --arch <arch>
bun run targets -- generate --format <json|github-matrix|posix|homebrew|documentation> \
  [--version <version>] [--os <os> --arch <arch>] --output <file> [--manifest <path>]
bun run targets -- check --format <json|github-matrix|posix|homebrew|documentation> \
  [--version <version>] [--os <os> --arch <arch>] --file <file> [--manifest <path>]
```

- `query` prints one complete target record (by stable `id` or by a
  normalized `os`/`arch` pair) as deterministic JSON.
- `generate` renders the whole document in memory and writes `--output`
  atomically (temporary file plus rename), so validation errors leave no
  partial output and preserve an existing destination.
- `check` byte-compares `--file` against the rendered document — key order,
  LF line endings, and the final newline included — succeeds only on an exact
  match, and never rewrites the checked file.
- `posix` selects a single record by `--os`/`--arch`; `homebrew` requires
  `--version` (a plain `<major>.<minor>.<patch>`).

Every document shares one byte contract: UTF-8 without a BOM, LF line endings
only, two-space indentation, object keys sorted lexicographically, and exactly
one final newline. Invalid arguments and validation errors go to stderr with a
nonzero exit status and no generated stdout.

## Local GitHub REST fixture

`src/github/rest-fixture.ts` provides a reusable, deterministic in-memory HTTP
fixture serving the GitHub-shaped issue, comment, and native sub-issue and
dependency endpoints used by `makeGitHubIssuesService`,
`makeGitHubIssueMutationsService`, and
`makeGitHubIssueRelationshipService`: list/paginate issues, read issues and
comments, create/update/close issues (with lost-response reconciliation), and
the `client.request` relationship routes. Start one with
`startGitHubRestFixture()`, seed repository records and relationships, point a
real Octokit client at `fixture.baseUrl` (pass it to the explicit
`makeGitHubClientService` seam or set `RALPHIE_GITHUB_REST_FIXTURE_URL`), and
drive the actual domain services against it.

Per-operation response sequences (`fixture.enqueue`) can force controlled
HTTP, malformed, or lost-response failures; every request is recorded as a
method/path/body/authorization observation in fixture memory, outside the
Ralphie state volume. Unknown or public-shaped paths are rejected with a loud
HTTP 500 and are never proxied. The unit suite drives the production domain
services against the fixture (see `tests/github/issues.test.ts`).

The `bun run test` suite is deliberately small: fast, in-memory unit tests
only. The former disposable integration suites (temporary Git repositories,
installer, docker image, Homebrew reconciliation, release processes, and the
opt-in network smoke tests) were removed to keep the gate under a few seconds;
git history preserves them if they are ever needed again.

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
remaining files under `tests/` (use `src/github/rest-fixture.ts` for GitHub
paths). Do not
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
