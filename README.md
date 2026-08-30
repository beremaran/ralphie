# Ralphie

**Turn a GitHub issue queue into reviewed commits with Pi.**

[![CI](https://github.com/beremaran/ralphie/actions/workflows/ci.yml/badge.svg)](https://github.com/beremaran/ralphie/actions/workflows/ci.yml)

Ralphie is an opinionated, resumable CLI that reads open GitHub issues, asks
[Pi](https://github.com/earendil-works/pi) for schema-validated decisions, and
routes each issue to either focused implementation or dependency-aware
decomposition. Agents handle reasoning and code changes; Ralphie keeps Git,
GitHub, run state, recovery, and safety checks deterministic.

> [!CAUTION]
> Ralphie defaults to the `lgtm` workflow: it works directly on the branch
> selected by `--branch`, commits approved work, and pushes directly to that
> branch. Use `--workflow pr` to deliver through an automatically merged feature
> branch and pull request instead. Ralphie is pre-1.0. Start with a one-issue
> `--dry-run` against a repository you control before enabling mutations.

For task-oriented details, start with the [documentation index](./docs/README.md).

## What Ralphie provides

- **Issue-native automation** — each run focuses on one repository, with the
  issue as the unit of planning, execution, recovery, and reporting.
- **Structured agent decisions** — complexity, reviews, decompositions, and
  commit messages are validated against explicit schemas.
- **Fresh-context review loops** — implementation, review, and review-fix work
  run in separate Pi sessions to reduce context bias.
- **Deterministic delivery** — Ralphie stages, inspects, commits, and pushes the
  resulting changes itself; agents do not own the delivery protocol.
- **Crash-safe recovery** — versioned run state, issue checkpoints, artifacts,
  and idempotent reconciliation make interrupted runs resumable.
- **Observable, bounded autonomy** — transcripts, progress, JSON Lines output,
  credential redaction, a five-attempt review limit, and non-force pushes are
  built in.

## Install and try it

Ralphie requires [Bun](https://bun.sh/), Git, the [GitHub CLI](https://cli.github.com/),
and model credentials supported by Pi. The shortest way to verify the published
package is:

```bash
bunx @beremaran/ralphie --version
```

The standalone release installer is also available. Verification is mandatory;
install the Sigstore CLI and a SHA-256 utility before using it:

```bash
curl -fsSL https://raw.githubusercontent.com/beremaran/ralphie/main/scripts/install.sh | sh
ralphie --version
```

Configure `GH_TOKEN` (preferred) or `GITHUB_TOKEN` for noninteractive access to
`github.com`, and configure Pi in `~/.pi/agent/auth.json` or with `--pi-dir`.
For an OpenAI-compatible endpoint, use `RALPHIE_MODEL_BASE_URL` and, when
required, `RALPHIE_MODEL_API_KEY`. See [Getting started](./docs/getting-started.md)
for installation, authentication, container, and source-checkout details.

Preview one issue without implementation, commits, pushes, or GitHub mutations:

```bash
bunx @beremaran/ralphie owner/repository --dry-run --max-issues 1
```

Dry-run still performs preflight, issue discovery, read-only grounding, and
may prepare or reset the local workspace. Read the [safety model](./docs/safety.md)
before using mutation-enabled commands.

## Public distribution

The [latest release](https://github.com/beremaran/ralphie/releases/latest) and
its [release assets](https://github.com/beremaran/ralphie/releases) are public.
The supported standalone installer is
[install.sh](https://raw.githubusercontent.com/beremaran/ralphie/main/scripts/install.sh);
it supports macOS and Linux on `arm64` and `x64`. Release tags use the strict
`v<major>.<minor>.<patch>` form; the installer accepts either that tag or the
version without `v`.

Other canonical channels are the [Homebrew tap](https://github.com/beremaran/ralphie)
and [formula source](https://raw.githubusercontent.com/beremaran/ralphie/main/Formula/ralphie.rb),
the [OCI image](https://ghcr.io/beremaran/ralphie), the
[published npm package](https://www.npmjs.com/package/@beremaran/ralphie), and
the [MIT license](https://github.com/beremaran/ralphie/blob/main/LICENSE).
Public artifacts do not require GitHub credentials. Operating on a private target
repository still requires `GH_TOKEN` (preferred) or `GITHUB_TOKEN`; Pi model
credentials are also required when Ralphie asks Pi to make a decision.

## Output contract

`--output` selects `default`, `verbose`, `quiet`, or `json`. In an interactive,
non-CI terminal, the default is a Pi transcript with an in-place sticky footer.
The footer is refreshed periodically and describes the active leaf stage and
activity—for example, `› Reviewing changes › Using bash`—rather than a global
step count. Completed progress milestones remain in scrollback. Pi sessions
start with contextual headers such as:

```text
╭─ Pi · Task · session-1 · owner/repo · issue 2/4 · #56 · Reviewing changes · attempt 1/3
```

Human-readable output also records lifecycle breadcrumbs for events such as
context compaction and Pi retries. Tool output is bounded for terminal use:
`LIVE_OUTPUT_LIMIT` is the rendered-output threshold, measured in characters,
with a default of `2,400` per tool call. Final human previews use the `maxLines`/`maxCharacters` limits of 12
lines/2,400 characters by default, or 40 lines/8,000 characters with
`--output verbose`; these are not limits on the structured stream.

Outside an interactive terminal—including CI—plain output is append-only and
uses no ANSI cursor controls. Quiet output reports failures and handled
needs-attention stops only. JSON output is
JSON Lines on stdout: each line is a parseable progress record or a lossless
`pi_event` record, without
human breadcrumb lines. The redacted durable progress-event log remains at
`<workspace>/.ralphie/runs/<run-id>/events.jsonl` independently of the selected
renderer. Credentials, sensitive environment values, terminal controls, and
other unsafe display text are redacted or sanitized at the reporting boundary.
See [Operations and recovery](./docs/operations-and-recovery.md) for output,
resume, and cleanup details; successful `--clean end` removes the workspace
and its log, while failed runs retain diagnostics for recovery.

## How issue routing works

Every selected open issue is refreshed from GitHub, then receives a read-only
grounding decision:

```mermaid
flowchart TD
    A[Refreshed live issue] --> G[Read-only grounding]
    G -->|actionable| C[Complexity 0-5]
    G -->|already_resolved| V[Fresh read-only resolution verifier]
    G -->|needs_attention| D{--on-needs-attention}
    D -->|halt default| H[Handled stop, exit 2, resumable]
    D -->|continue| Q[Leave open, continue queue]
    C -->|0-3| I[Implementation, review, delivery]
    C -->|4-5| X[Decomposition]
    V -->|resolved with evidence| O[Complete as already-resolved]
    V -->|unresolved or uncertain| F[Fail safely, leave open]
```

- **Actionable** issues receive a complexity score: **0–3** enter
  implementation, review, deterministic verification, and delivery; **4–5**,
  and implementation that exhausts its review budget, enter decomposition into
  linked child issues.
- **Already-resolved** issues close only after a separate fresh verifier
  returns a nonblank summary and concrete evidence; unresolved or uncertain
  verification fails safely without closing or deferring the issue.
- **Needs attention** issues are never closed, marked complete, or delivered:
  Ralphie persists the decision with its reason, summary, evidence, questions,
  and an issue-freshness fingerprint (`updatedAt`, comment count, and comment
  version) in the per-issue artifact store, and progress events carry the same
  fields plus the artifact path, policy, and queue position. Complexity,
  difficulty, size, or uncertainty are never valid needs-attention reasons, and
  the source issue always remains open.

`--on-needs-attention halt` (the default) keeps the issue in the run state's
pending queue, emits a handled-stop summary, and exits with code `2`; the run
resumes later with `--resume`, reusing the persisted decision only while the
issue's fingerprint still matches. `continue` defers the issue, processes the
rest of the queue, and exits `0` when the queue drains. Both policies consume
the attempt against `--max-issues`. An explicit `--notify-needs-attention`
opt-in (with optional `--needs-attention-label`) publishes one idempotent
structured comment and label per issue, saved as resumable intent before any
GitHub mutation; dry runs never notify.

`--dry-run` grounds every issue, reports all three routes, and performs no
implementation, checkout mutation, Git or GitHub mutation, issue closure, or PR
delivery. Pi sessions never close issues, create or merge pull requests, or
push: every Git and GitHub mutation is performed by Ralphie's deterministic
domain services, and agent sessions are denied mutating Git and GitHub
commands.

See [Workflows](./docs/workflows.md) for the full routing, implementation,
decomposition, and delivery contracts, and
[Operations and recovery](./docs/operations-and-recovery.md) for the exact
state, artifact, progress, and exit-code contracts.

## Documentation

The [documentation index](./docs/README.md) has audience-based reading paths.
The main references are:

- [Getting started](./docs/getting-started.md) — prerequisites, installation,
  verification, and the first dry run.
- [Workflows](./docs/workflows.md) — routing, implementation, decomposition,
  delivery modes, and diagrams.
- [CLI reference](./docs/cli-reference.md) — invocation, options, environment
  variables, and recipes.
- [Safety](./docs/safety.md) — mutation boundaries, Git/GitHub invariants, and
  workspace risks.
- [Operations and recovery](./docs/operations-and-recovery.md) — output,
  artifacts, state, cancellation, resume, and cleanup.
- [Architecture](./docs/architecture.md) — runtime/domain boundaries and the
  component map.
- [Development](./docs/development.md) — local setup, tests, and contribution
  expectations.
- [Public distribution topology](./docs/public-distribution.md) — canonical
  repository, public endpoints, publication setup, and privacy boundaries.
- [Releases](./docs/releases.md) — compatibility, publishing, and release
  verification.
- [End-to-end execution trace](./docs/end-to-end-execution.md) — the detailed
  source-level trigger-to-exit path.

## Version and build metadata

`ralphie --version` prints only the release version. For automation,
`ralphie --version --output json` prints a stable object containing `version`
and `commitSha`. Both forms work without a repository, GitHub credentials, or
Pi configuration. Release builds embed the immutable commit SHA supplied by
the build entry point; local builds use the documented `local` commit sentinel
when no release SHA is supplied. See the [CLI reference](./docs/cli-reference.md)
for the complete command surface.

## Contributing and releases

Contributions are welcome. For substantial behavior or workflow changes, open
an issue first so the safety and recovery implications can be discussed. Add or
update tests, run `bun run check`, keep Git and GitHub mutations in deterministic
domain services, and put future documentation changes in the appropriate page
under [`docs/`](./docs/README.md). See [Development](./docs/development.md) for
the contributor checklist.

Ralphie follows [Semantic Versioning](https://semver.org/). Release candidates
must pass `bun run check`; the full compatibility and publishing contract is in
[Releases](./docs/releases.md), with notable changes recorded in
[`CHANGELOG.md`](./CHANGELOG.md).

For a release checksum, the authoritative trust policy and explanation are in
[Releases](./docs/releases.md). This runnable verification command is kept as a
small landing-page quick reference:

```bash
TAG=v0.1.0
SOURCE_REF=<40-character commit SHA targeted by $TAG>
sigstore verify github SHA256SUMS \
  --bundle SHA256SUMS.sigstore.json \
  --repository beremaran/ralphie \
  --name Release \
  --cert-identity "https://github.com/beremaran/ralphie/.github/workflows/release.yml@refs/tags/$TAG" \
  --trigger push \
  --sha "$SOURCE_REF" \
  --ref "refs/tags/$TAG"
sha256sum --check SHA256SUMS
```
