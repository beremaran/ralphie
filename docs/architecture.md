# Architecture

This page is for contributors and maintainers who need the runtime and domain
boundaries, component map, or source locations. It is the authoritative
architecture overview. Return to the [documentation index](README.md), and see
the [end-to-end execution trace](end-to-end-execution.md) for the detailed
source-level sequence.

## Runtime boundaries

Ralphie uses Bun's built-in argument parser and native promises. Services are
assembled as an explicit dependency object, which keeps the runtime small and
makes tests straightforward without a framework-specific execution model.

```mermaid
flowchart LR
    U[Operator] --> CLI[Native Bun CLI]

    subgraph RP["Ralphie process"]
        CLI --> W[Workflow orchestrator]
        W --> Q[Issue queue and executors]
        W --> S[Run state and artifacts]
        W --> P[Progress and audit events]
        Q --> OC[Pi adapter]
        Q --> GD[Git domain]
        Q --> GHD[GitHub domain]
    end

    AUTH[Local gh CLI] --> GHD
    GHD <--> GH[GitHub API]
    GD <--> REPO[Workspace checkout]
    OC <--> SERVER[Embedded Pi model runtime]
    S --> DISK[Versioned JSON and issue artifacts]
    P --> TERM[Terminal or JSON Lines]
```

The workflow orchestrator owns sequencing, while domain services own side
effects and validate their invariants at the boundary.

| Area | Responsibility |
| --- | --- |
| `src/github/` | GitHub CLI authentication, Octokit, issue discovery, mutations, native sub-issues/dependencies, decomposition links, pipeline snapshot collection, and bounded pipeline observation. |
| `src/git/` | Checkout preparation, checkpoints, deterministic issue operations, invariants, and remote safety. |
| `src/issues/` | Queueing, complexity routing, implementation, review, recovery, and decomposition. |
| `src/agent/` | Ralphie's session, prompt, schema, diagnostics, and structured-output boundary. |
| `src/pi/` | Embedded upstream Pi client, model runtime, tools, and safety policy. |
| `src/progress/` | Typed events, audit persistence, redaction, and terminal/JSON renderers. |
| `src/run/` | Versioned state, artifacts, reconciliation, and resume behavior. |
| `src/workspace/` | Path expansion and protected workspace removal. |
| `src/targets/` | Canonical standalone release target manifest, typed parser/loader, read-only target query API, deterministic catalog/GitHub Actions matrix JSON serializers, and stable consumer renderers (POSIX installer, Homebrew, documentation). |
| `src/process/` | External command execution and process exit semantics. |

`src/workflow.ts` orchestrates the domain services. `src/runtime.ts` assembles
their live implementations into one explicit runtime object.

## Read-only pipeline observation contract

The live runtime exposes `runtime.pipelineObservation.observe(...)` for a later
workflow gate. It observes one immutable 40- or 64-character commit SHA and is
read-only: with an Octokit client it uses paginated Check Run and legacy commit
status reads plus `repos.getBranch` for the final HEAD race check. Tests and
other read-only callers may provide `fetchSnapshot`, `readHead`, and injected
clock/sleep/request dependencies without importing the collector internals.

The canonical settings and defaults are:

| Setting | Default | Policy |
| --- | ---: | --- |
| `registrationGraceMs` | `0` | Keep polling an empty `no-checks` snapshot until grace expires, then return `no-pipelines-discovered`. |
| `quiescenceMs` | `0` | Require the terminal normalized set to remain unchanged for this window. |
| `deadlineMs` | `30,000` | Absolute bound from `observe` start; timeout wins over a late read or sleep. |
| `initialBackoffMs` / `maxBackoffMs` | `1,000` / `30,000` | Exponential polling backoff, capped at the maximum and remaining deadline. |
| `backoffFactor` | `2` | Multiplier for ordinary polling delays. |
| `rateLimitRetries` | `3` | Maximum retries per poll when a usable server hint is available. |
| `maxRateLimitDelayMs` | `30,000` | A larger `Retry-After` or reset delay fails closed instead of being silently capped. |
| `stableTerminalConfirmations` | `1` | Number of identical green terminal snapshots required. |

A green result requires at least one complete item, every item to be `passing`,
no source or completeness errors, the configured stability checks, and a final
branch HEAD equal to the observed SHA. Pending items continue polling until the
absolute deadline. Failing or cancelled items fail closed; neutral and skipped
items are retained as `acceptable` but are not green. Unknown API values,
malformed records, missing scope, collection failures, and no checks after grace
are non-green outcomes. Rate-limit hints are honored exactly only when the
hint fits both the configured cap and remaining deadline. Every request and
sleep receives an abortable derived signal; caller cancellation returns an
`aborted` outcome with its original reason, distinct from timeout or read
failure. Normalized items retain source/producer identity and raw diagnostic
fields for audit consumers.

## Dependency and side-effect rules

Agents own reasoning and edits within their permitted tool boundary. They do not
own commits, pushes, issue mutations, or delivery sequencing. Deterministic
services under `src/git/` and `src/github/` perform those side effects and
verify their invariants. The explicit runtime object makes these boundaries
testable without a framework-specific execution model.

Pi configuration is separate from persistent workspace state: it is read from
the default or explicitly supplied `--pi-dir`, or generated in a private
system-temporary directory when model environment variables are used. Run state
and recovery artifacts belong under the workspace's `.ralphie` directory.

For workflow behavior and the agent/deterministic boundary, see [Workflows](workflows.md)
and [Safety](safety.md). For state transitions and reconciliation, see
[Operations and recovery](operations-and-recovery.md).

## Standalone target consumer renderers

`src/targets/standalone-target-renderers.ts` exposes stable, typed consumer
projections on top of the target query API and serializers. Every renderer
accepts unknown manifest input, parses and exact-target-validates the whole
manifest through `createStandaloneTargetQueryClient` before deriving anything,
and throws before any output exists for malformed or non-canonical manifests.
The renderers never carry their own target list: the four-target catalog is
always read from the validated manifest, and the query API and serializers are
never edited. Output arrays and records are frozen, records stay sorted by
stable `id`, and every manifest field (`releaseAssetName`, `bunCompileTarget`,
`targetTriple`, `runner`, `binaryFormat`, `bunVersion`, `dockerPlatform`) is
passed through unmodified rather than reconstructed from an asset name.

Stable shapes and format names consumed by the release, installer, Homebrew,
and documentation follow-up work:

- `posix-installer-target` — `renderPosixInstallerTarget(value, os, arch)`
  normalizes the OS/architecture pair through the query API and returns the
  matching full `StandaloneTarget` record. The downloaded asset is exactly the
  returned record's `releaseAssetName`; it is never rebuilt from the pair.
- `homebrew-target-rows` — `renderHomebrewTargetRows(value, version)` returns
  rows sorted lexicographically by stable `id`. Each `HomebrewTargetRow`
  contains the complete manifest record nested under `target`, the explicit
  `version` input (plain `<major>.<minor>.<patch>`, validated; a leading `v`,
  leading zeros, prerelease, or build suffix is rejected with
  `InvalidHomebrewVersionError`), and a derived `downloadUrl` built from
  `target.releaseAssetName` at
  `https://github.com/beremaran/ralphie/releases/download/v<version>/<releaseAssetName>`.
- `target-documentation-catalog` — `renderDocumentationTargets(value)` returns
  the complete catalog sorted lexicographically by stable `id`, with every
  validated field preserved as typed values for documentation consumers.

For finished JSON documents (catalog or GitHub Actions matrix), pair the typed
projections with the document serializers in
`standalone-target-serializer.ts` (`serializeStandaloneTargets`,
`serializeStandaloneTargetMatrix`); the renderers themselves stay in memory.

## Source map

| Concern | Primary source |
| --- | --- |
| Public trigger and flags | `index.ts`, `src/cli.ts`, `src/command.ts`, `src/options.ts` |
| Runtime dependency assembly | `src/runtime.ts` |
| Run orchestration, queue, state transitions | `src/workflow.ts`, `src/issues/queue.ts` |
| Pipeline snapshot normalization and collection | `src/github/pipeline-snapshot.ts`, `src/github/pipeline-snapshot-collector.ts` |
| Bounded, deadline-aware pipeline observation, paginated exact-SHA reads, retries, and final HEAD check | `src/github/pipeline-observation.ts`, `src/github/pipeline-snapshot-collector.ts` |
| Complexity routing | `src/issues/executor.ts`, `src/issues/complexity.ts` |
| Implementation/review/delivery | `src/issues/implementation-executor.ts` |
| Decomposition and GitHub mutations | `src/issues/decomposition-executor.ts`, `src/github/issue-mutations.ts`, `src/github/issue-relationships.ts` |
| Pi sessions and structured results | `src/agent/`, `src/pi/` |
| Git checkpoints, safety, and branches | `src/git/` |
| Durable state and reconciliation | `src/run/`, `src/issues/artifacts.ts` |
| Progress, redaction, and exit semantics | `src/progress/`, `src/shared/redaction.ts`, `src/process/exit-code.ts` |
| Standalone release target manifest, read-only query API, deterministic catalog/matrix JSON serializers, and consumer renderers (installer/Homebrew/documentation) | `src/targets/`, `targets/standalone-targets.json` |

The source-level trigger-to-exit path is maintained in the [end-to-end
execution trace](end-to-end-execution.md), which cross-references these
components by stage.
