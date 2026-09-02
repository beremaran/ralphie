# AGENTS.md

Bun 1.3.14 pinned in CI (`engines: >=1.3.0`) + TypeScript strict + `@types/bun`. Entry `index.ts` → `src/cli.ts` → `src/command.ts` (Bun `parseArgs`, Zod, `resolveRalphieConfig`). Services assembled as explicit DI object in `src/runtime.ts`; `src/workflow.ts` orchestrates `issues` mode, `src/maintain-issues.ts` handles `maintain-issues`. `--mode get-pipelines-green` is not implemented and throws. No config files, no framework.

## Commands

- Full local gate (same order as CI `ci.yml`): `bun run check` = `format:check → lint → typecheck → test → build`. Always `bun install --frozen-lockfile` first; run `bun run check` before considering work done.
- Focused verification: `bun run format:check` / `bun run lint` / `bunx tsc --noEmit` / `bun test tests/command.test.ts` (single file) / `bun test -t "<name>" tests/integration/local-end-to-end.test.ts` (single test).
- Build: `bun run build` → `dist/cli` (native binary, gitignored; local builds embed `local` sentinel from `src/build-info.ts`, release builds pass `--version/--commit-sha/--target darwin-arm64|darwin-x64|linux-arm64|linux-x64`). `bun run build:package` → `dist/ralphie.js` (publishable npm bundle).
- `bun run probe:structured-output` exercises a real Pi structured-output call (needs Pi credentials on `PATH`/env; `--union` / `--model` / `--agent` / `--variant` select the decision).

## Tests

- `bun run test` runs everything under `tests/` — unit + local e2e that build temporary git repos with a stubbed Pi client and the in-memory GitHub REST fixture (`src/github/rest-fixture.ts`). No network or credentials required, safe to run.
- Real-network tests in `tests/integration/network-smoke.test.ts` are opt-in and self-skip: `RALPHIE_RUN_PI_COMPLEXITY_SMOKE=1`, `RALPHIE_RUN_PI_IMPLEMENTATION_SMOKE=1`, `RALPHIE_RUN_GITHUB_INTEGRATION=1`, `RALPHIE_RUN_GITHUB_SUB_ISSUES_SMOKE=1` (GitHub ones additionally require `RALPHIE_GITHUB_TEST_REPOSITORY` matching `test|sandbox|fixture|integration|smoke`; sub-issues one is mutating in that sandbox). Model selection via `RALPHIE_PI_SMOKE_MODEL` / `RALPHIE_PI_SMOKE_AGENT` / `RALPHIE_PI_SMOKE_VARIANT`.

## Conventions

- Biome: formatter 4-space indent, double quotes, semicolons (via `.editorconfig`); linter has only `noExcessiveCognitiveComplexity` (max 12). Keep functions small — this is the real constraint.
- `tsconfig.json` has `verbatimModuleSyntax` and `moduleResolution: bundler` — import `.ts` extensions, use `import type` for type-only imports.
- Git/GitHub mutations belong in deterministic domain services (`src/git/`, `src/github/`), never in `src/pi/` or `src/agent/` paths. Agents are denied mutating `git`/`gh` commands; Ralphie owns delivery. Cover new mutation paths with tests following existing patterns under `tests/`.

## Gotchas

- The CLI itself is the product under test: default `issues` mode + `lgtm` workflow **pushes directly to the selected branch and mutates GitHub issues**. Never run `bun run index.ts <owner/repo>` without `--dry-run` unless deliberately doing so; prefer `--dry-run --max-issues 1` against a repo you control. `--workflow pr` pushes to `ralphie/issue-<n>` and merges via a check-gated PR instead.
- Workspace defaults to `~/.ralphie` (`src/workspace/workspace.ts:7` resolves `~`). Reusing an existing workspace does a destructive `git reset --hard` + `git clean -fd` equivalent — don't point `--workspace` at anything with uncommitted work.
- `--clean start|end|both` recursively deletes the workspace after protected-path checks (`src/workspace/workspace.ts:20` refuses `/`, `~`, `$PWD`, or any parent of `$PWD`).
- Credentials are inputs, never logged (redacted at reporting boundary): `GH_TOKEN` preferred over `GITHUB_TOKEN`, Pi via `~/.pi/agent/auth.json` / `--pi-dir` or `RALPHIE_MODEL_BASE_URL` + `RALPHIE_MODEL_API_KEY`.

## Docs and release

- `docs/` is the source of truth for CLI surface, workflows, safety, recovery, architecture, development, and releases; `docs/end-to-end-execution.md` has the trigger-to-exit trace. Keep the root `README.md` as the landing page, update the appropriate `docs/` page when its contract changes, and update `CHANGELOG.md` when the command surface or recovery contract changes.
- Releases are tag-triggered: pushing a protected `v<major>.<minor>.<patch>` tag runs `release.yml`, which validates `package.json` version match, builds 4 native binaries (`darwin/linux × arm64/x64`), the npm package `@beremaran/ralphie`, and the Docker image `ghcr.io/beremaran/ralphie` (with Sigstore attestations/SBOMs). Don't push version tags casually; local version metadata comes from `src/build-info.ts` (`ralphie --version --output json` exposes `version` + `commitSha`).
