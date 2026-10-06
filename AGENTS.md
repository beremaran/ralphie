# Ralphie

Ralphie is a Bun + TypeScript CLI (published to npm as `@beremaran/ralphie`) that reads open GitHub issues, asks a headless harness CLI (Claude Code first) for schema-validated decisions, and routes each `ready-for-agent` issue, after a pre-flight session, to implementation or decomposition into child issues. Anything needing a human becomes a hand-off (`needs-info` or `ready-for-human`). Agents do reasoning and edits; Ralphie's deterministic services own Git, GitHub, run state, and safety checks.

## Commands

```bash
bun install --frozen-lockfile
bun run check                      # full gate: format:check, lint, typecheck, source:audit, test, build
bun run test                       # bun test tests (offline; no GitHub/model/npm credentials needed)
bun test tests/options.test.ts     # single file
bun test tests/git -t "<name>"     # filter by directory and test name
bun run typecheck                  # tsc --noEmit
bun run lint                       # Biome; the only rule is cognitive complexity <= 12
bun run format                     # Biome, 4-space indent, double quotes, semicolons
bun run source:audit               # offline reachability audit from index.ts / scripts/build.ts
bun run build                      # bundles dist/ralphie.js
bun run start -- owner/repo        # run from source (needs a config file; `ralphie init` writes one)
bun run skills:sync [ref]          # refresh vendor/mattpocock-skills from upstream (network)
bun run smoke:live -- --scratch-repo owner/repo   # opt-in live run against a scratch repo; never part of check
```

CI runs `format:check`, `lint`, `typecheck`, `test`, and `build`, but not `source:audit`. That audit only runs in `bun run check`, so run it locally.

Never point the mutating CLI at a repository you don't control. It commits and pushes directly to the configured branch, and it recursively deletes the selected workspace before and after a successful run.

## Architecture

Flow: `index.ts` → `src/cli.ts` / `src/command.ts` / `src/options.ts` (inbound adapter, terminal decision, top-level error boundary) → `src/runtime.ts` (composition root) → `src/workflow/workflow.ts` (orchestration via the `IssueWorkflow` port in `workflow/ports.ts`).

`src/` is split into bounded contexts (`agent`, `config`, `harness`, `github`, `git`, `issues`, `progress`, `run`, `process`, `workspace`, `workflow`) plus `shared/`. Each context has a `ports.ts` contract and an `adapters/` folder. The `issues` context also has `domain/` and `app/`; the routing, implementation, decomposition, verification, artifacts, and recovery logic is in `issues/app/`.

`tests/architecture.test.ts` enforces these rules, so violations fail the suite:

- Contexts may import another context's `ports.ts` and domain modules, never its `adapters/`. Only `runtime.ts` and `command.ts` instantiate adapters.
- Non-adapter code must not import `node:fs`, `node:child_process`, vendor SDKs, or process streams. File-system ports used by app code (e.g. `IssueArtifactFileSystem`, `RecoveryFileSystem`) are declared in `issues/app/` and implemented in `issues/adapters/`.
- Octokit appears only in the `github` context.
- Application code never reads the clock, generates IDs, or builds workspace paths itself. `Clock`, `IdGenerator`, and `RunLayout` are injected.

Agents never commit, push, or mutate issues. Those side effects belong to `src/git/adapters/` and `src/github/adapters/`, which also verify their own invariants (non-force push, checkpoint restore, remote rechecks).

Agent output is structured: results are zod-validated values (the harness's native schema output where it has one, otherwise a final fenced JSON block, with bounded correction turns), not prose. Prose or premature termination does not count as completion.

The `harness` context owns the provider-neutral port, the service that runs sessions, and one CLI adapter per harness (Claude Code, Codex, pi, OpenCode). Every agent session goes through `runtime.harness`, which adds session isolation, the read-only fingerprint guard, and skill injection; never bypass it. `config` supplies the YAML settings; the `harnesses` and `roles` keys assign a harness, model, and effort to each of the eight roles (`triager`, `preflight`, `implementer`, `fixer`, `standards-reviewer`, `spec-reviewer`, `resolution-verifier`, `decomposer`). Role-to-session mapping and access modes live in `src/agent/sessions.ts`. A new adapter must pass `tests/contracts/harness-adapter.contract.ts` and be registered in `makeHarnessAdapters` in `runtime.ts`.

Sessions run Matt Pocock's skills from the pinned, hand-edit-forbidden copy in `vendor/mattpocock-skills/` (change it only with `bun run skills:sync`; local changes belong in prompt overlays, see ADR-0002). Hand-offs are the only way an issue is handed back to a human: they live in `issues/domain/hand-off.ts`, `issues/app/hand-off.ts` and `github/adapters/hand-off.ts`, and every comment Ralphie posts goes through `withDisclaimer`.

The progress UI (`src/progress/adapters/`) has an OpenTUI interactive adapter (`tui.ts`, with an issue sidebar, transcripts, pause/stop controls; it renders only harness-neutral session events) plus plain and JSON Lines adapters behind `progress/ports.ts`.

Run state and recovery artifacts live under the workspace's `.ralphie/` directory. Agent config and credentials are never stored there; each harness CLI keeps its own login and credentials, and the `harnesses`/`roles` config keys choose the harness, model and effort per role.

## Testing conventions

- Use in-memory fakes, following the patterns already in `tests/`. `tests/contracts/` holds shared behavioral suites that both the fakes and the real adapters must pass (e.g. `RunEventLog`, `IssueArtifactStore`). When adding a port implementation, run it against the matching contract suite.
- A test importing a module doesn't make that module part of the runtime boundary. If `source:audit` reports something unreachable, test it through the production seam rather than adding an import just to satisfy the audit. The intentional `scripts/build.ts` → `src/build-info.ts` exceptions are documented in `docs/development.md`.

## Documentation ownership

Each fact belongs on one page under `docs/`. Don't add contracts to the root README. The pages are: config keys and removed flags (`configuration.md`), CLI options (`cli-reference.md`), routing and delivery (`workflows.md`), mutation boundaries (`safety.md`), output, state, and recovery (`operations-and-recovery.md`), components (`architecture.md`), and publishing, the live smoke script, and vendored-skill syncing (`development.md`). Update `CHANGELOG.md` when the command surface, the output shape, the run-state version, or the recovery contract changes.

Releases: bump `package.json` `version` and `CHANGELOG.md`, then push a `v<x.y.z>` tag. The publish workflow handles the rest.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, operated via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five canonical labels (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (one GLOSSARY.md + docs/adr/ at the repo root). See `docs/agents/domain.md`.