# AGENTS.md

Bun + TypeScript CLI (strict mode, `@types/bun`). Entry point: `index.ts`. Services are assembled as an explicit dependency object in `src/runtime.ts`; `src/workflow.ts` orchestrates. No config files, no framework — Bun's built-in arg parser and native promises.

## Commands

- Full local gate (same order as CI): `bun run check` = `format:check → lint → typecheck → test → build`. Run this before considering work done.
- Focused test: `bun test tests/command.test.ts` (single file) or `bun test -t "<test name>" tests/integration/local-end-to-end.test.ts` (single test).
- `bun run build` outputs `dist/cli` (native binary, gitignored).
- `bun run probe:structured-output` exercises a real Pi structured-output call (needs Pi credentials on `PATH`/env).

## Tests

- `bun run test` runs everything under `tests/`, including local e2e tests that build temporary git repos with a stubbed Pi client — no network or credentials required, safe to run.
- Real-network tests in `tests/integration/network-smoke.test.ts` are opt-in and self-skip: `RALPHIE_RUN_PI_COMPLEXITY_SMOKE=1`, `RALPHIE_RUN_PI_IMPLEMENTATION_SMOKE=1`, `RALPHIE_RUN_GITHUB_INTEGRATION=1`, `RALPHIE_RUN_GITHUB_SUB_ISSUES_SMOKE=1` (the GitHub ones additionally require `RALPHIE_GITHUB_TEST_REPOSITORY` pointing at a repo whose name matches test/sandbox/fixture/integration/smoke, or they refuse to run; the sub-issues one is mutating in that sandbox). Model selection via `RALPHIE_PI_SMOKE_MODEL` / `RALPHIE_PI_SMOKE_AGENT` / `RALPHIE_PI_SMOKE_VARIANT`.

## Conventions

- Lint is Biome with only `noExcessiveCognitiveComplexity` (max 12) enabled; formatting is Biome (4-space indent, double quotes, semicolons on). Keep functions small — the complexity rule is the real constraint.
- `tsconfig.json` has `verbatimModuleSyntax` and `moduleResolution: bundler` — import `.ts` extensions, use `import type` for types-only imports.
- Git/GitHub mutations belong in the deterministic domain services (`src/git/`, `src/github/`), never in agent/Prompt paths. Tests must cover Git and GitHub mutation paths per the patterns in `TODO.md` sections 5/8/9.

## Gotchas

- The CLI itself is the product under test: the default `lgtm` workflow **pushes directly to the selected branch and mutates GitHub issues**. Never run `bun run index.ts <repo>` without `--dry-run` unless deliberately doing so; prefer `--dry-run --max-issues 1` against a repo you control.
- Reusing an existing workspace does a destructive `git reset --hard` + `git clean -fd` equivalent against that checkout — don't point `--workspace` at anything with uncommitted work.
- `--clean end|both|start` recursively deletes the workspace after protected-path checks.

## Docs and release

- The documentation pages under `docs/` are the source of truth for the CLI surface, workflows, safety, recovery, architecture, development, and releases; `docs/end-to-end-execution.md` has the trigger-to-exit execution trace. Keep the root README as the landing page, update the appropriate docs page when its contract changes, and update `CHANGELOG.md` when the command surface or recovery contract changes.
- Releases are tag-triggered: pushing a `v*` tag runs `release.yml`, which builds per-platform binaries (darwin/linux × arm64/x64) and publishes the Docker image to `ghcr.io/beremaran/ralphie`. Don't push version tags casually.
