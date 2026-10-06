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
| `bun run skills:sync [ref]` | Replace the vendored copy of mattpocock/skills with the given upstream ref (default: the upstream default branch) and rewrite its lock file. Needs network access to GitHub; see [Vendored skills](#vendored-skills). |

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
`src/runtime.ts`, and `src/workflow/workflow.ts` orchestrates them. Formatting is Biome
with four-space indentation, double quotes, and semicolons. Keep functions
small: the configured cognitive-complexity limit is the meaningful lint
constraint.

## Live smoke script

`bun run smoke:live` (`scripts/live-smoke.ts`) runs the real CLI against a
scratch GitHub repository with each installed harness (`claude`, `codex`,
`pi`, `opencode`; missing executables are skipped). For each harness it files
three issues labelled `ready-for-agent` and `smoke-<harness>` (an
implementation task that goes through review, an ambiguous task that must end
in a hand-off, and an oversized task that must be decomposed), runs Ralphie
with every role on that harness in `yolo` approval, checks the outcomes, and
closes the issues afterwards as not planned (`--keep-issues` leaves them).
Each harness ends as PASS, FAIL or INCONCLUSIVE. The decomposition scenario
passes only when a child issue was then worked to a genuine terminal outcome:
closed as completed by Ralphie, or handed off for a real reason rather than a
failed session. When Ralphie exits `75` because a usage limit, outage or
expired login halted the run, the harness is INCONCLUSIVE, not a pass or a
failure; rerun it once the limit clears.

It is never run by `bun run test`, `bun run check`, or CI: it needs live
harness logins, model spend, and GitHub credentials. Run it by hand before a
release or after changing an adapter, prompt, or hand-off path:

```bash
RALPHIE_SMOKE_SCRATCH_REPO=you/ralphie-scratch \
  bun run smoke:live -- --scratch-repo you/ralphie-scratch --harness claude,codex
```

The scratch repository must be named both by flag and by the
`RALPHIE_SMOKE_SCRATCH_REPO` environment variable, and the project repository
is refused. Use a throwaway repository: Ralphie commits and pushes to its
default branch. Outcomes depend on model judgement, so one failed scenario is
a prompt to inspect the run, not necessarily a regression. The script has
never been run live: it was written and unit-tested for its guard and argument
parsing only, so expect to fix the first real run.

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

## Vendored skills

Ralphie runs Matt Pocock's skills from a pinned copy in this repository, not
from whatever a user has installed ([ADR-0002](adr/0002-vendored-skills-with-overlays.md)).
The copy lives in `vendor/mattpocock-skills/`:

- one directory per skill (`triage`, `to-tickets`, `implement`, `tdd`,
  `code-review`, `codebase-design`, `diagnosing-bugs`), flattened from
  upstream's `skills/<bucket>/<name>/`, so the directory is itself a skills
  directory and each skill keeps its references and `agents/` metadata;
- `LICENSE`, the upstream MIT license; and
- `lock.json`, which records the upstream repository, the full commit id, where
  each skill lives upstream, and the git blob id of every vendored file.

The copy is published: `package.json` `files` includes `vendor/mattpocock-skills`,
and `bun run package:check` fails if a locked file is missing from the tarball
or the installed package. The bundled `dist/ralphie.js` finds the copy at
`../vendor/mattpocock-skills` relative to its own directory.

**Never hand-edit anything under `vendor/mattpocock-skills/`.** Where Ralphie's
contract departs from a skill's text, the difference belongs in a Ralphie skill
overlay. `tests/skills-sync.test.ts` verifies that the checked-in files are
exactly the blobs named in `lock.json`, so an edit, a stray file, or a hand-built
lock fails `bun run test`. The directory is excluded from Biome, and
`.gitattributes` marks it `-text` so line endings are never rewritten.

### Syncing

`bun run skills:sync [ref]` fetches `ref` (a branch, tag, or commit of
`https://github.com/mattpocock/skills`; default `HEAD`) with a shallow, read-only
`git fetch` into a scratch repository, rebuilds the copy beside the vendored
directory, and swaps it in. Nothing in the output depends on the ref spelling, the
clock, or the machine, so syncing the same commit twice produces byte-identical
files, and the script prints the previous and new commit and the vendored files
that changed. It fails without touching the existing copy when the ref does not
resolve, upstream no longer has one of the driven skills (or has it in two
places), the license is missing, or a driven skill contains something that is not a
regular file. Adding a driven skill means adding its name to `VENDORED_SKILLS` in
`scripts/skills-sync.ts` and syncing.

To compare a lock with upstream by hand, `git ls-tree -r <commit>` in a clone of
upstream lists the same blob ids as `lock.json`.

### Scheduled sync and review

`.github/workflows/skills-sync.yml` runs weekly and on demand (`workflow_dispatch`
accepts an optional `ref`). It runs `bun run skills:sync`, and opens or updates
one pull request on the `skills-sync` branch only when the vendored files or skill
locations differ from the lock. An upstream commit that changes none of the driven
skills does not open a pull request. The pull request body links the upstream
compare view between the locked and new commits.
The repository setting "Allow GitHub Actions to create and approve pull requests"
must be enabled for the workflow to open the pull request.

Reviewing a sync pull request:

1. Read the upstream diff in the pull request (or its compare link) for each
   driven skill, not only the vendored paths.
2. Check whether the new skill text still fits Ralphie's contract: schema-validated
   tool results, no agent commits or pushes, direct delivery. Where it does not,
   change the Ralphie skill overlay in the same pull request, never the vendored
   files.
3. Pull requests opened with the workflow's token do not trigger CI. Close and
   reopen the pull request, or run `bun run check` on its branch, before merging.

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
