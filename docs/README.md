# Ralphie documentation

This directory is the detailed documentation set for Ralphie. The [root
README](../README.md) is the concise product overview and first-run guide;
these pages are the authoritative home for contracts that should not be
buried in a landing page.

## Suggested reading paths

### New user

1. [Getting started](getting-started.md) — prerequisites, installation,
   authentication, verification, and a safe first dry run.
2. [Safety](safety.md) — understand what dry-run does and what mutation-enabled
   runs can change.
3. [Workflows](workflows.md) — see how issues are routed and delivered.
4. [CLI reference](cli-reference.md) — choose options and adapt the recipes.

### Operator

1. [Safety](safety.md) — review direct-push defaults, invariants, and workspace
   risks before operating on a real repository.
2. [CLI reference](cli-reference.md) — invocation, filters, modes, output, and
   environment variables.
3. [Operations and recovery](operations-and-recovery.md) — interpret output,
   inspect artifacts, resume interrupted runs, and clean up safely.
4. [Workflows](workflows.md) — understand implementation, decomposition, and
   `lgtm` versus `pr` delivery.
5. [End-to-end execution trace](end-to-end-execution.md) — follow the source
   code from CLI trigger through exit.

### Contributor

1. [Development](development.md) — local setup, checks, tests, and contribution
   expectations.
2. [Architecture](architecture.md) — runtime assembly and domain boundaries.
3. [Workflows](workflows.md) — behavior and mutation boundaries to preserve.
4. [Operations and recovery](operations-and-recovery.md) — state and recovery
   contracts that changes must not break.
5. [End-to-end execution trace](end-to-end-execution.md) — the detailed source
   map and execution sequence.

### Release maintainer

1. [Development](development.md) — the local release validation gate.
2. [Releases](releases.md) — version compatibility, protected tags, artifacts,
   containers, and checksum trust.
3. [Operations and recovery](operations-and-recovery.md) — operational state and
   cleanup behavior.

## Page map

| Page | Purpose |
| --- | --- |
| [Getting started](getting-started.md) | Install Ralphie, configure credentials, verify it, and run the first dry run. |
| [Workflows](workflows.md) | Explain issue routing, implementation, decomposition, and delivery modes. |
| [Safety](safety.md) | Define deterministic Git/GitHub safety checks and destructive workspace behavior. |
| [CLI reference](cli-reference.md) | Record the command syntax, options, defaults, environment variables, and recipes. |
| [Operations and recovery](operations-and-recovery.md) | Document progress, artifacts, state, resume, cancellation, failure, and cleanup. |
| [Architecture](architecture.md) | Map runtime, orchestrator, domain services, and source locations. |
| [Development](development.md) | Explain local development, test commands, network smoke tests, and contribution rules. |
| [Releases](releases.md) | Define release compatibility, workflow, Homebrew, containers, and checksum verification. |
| [End-to-end execution trace](end-to-end-execution.md) | Preserve the detailed source-level trigger-to-exit trace. |

## Keeping documentation current

Keep each contract authoritative on one page. Put new CLI options in the [CLI
reference](cli-reference.md), workflow behavior in [Workflows](workflows.md),
recovery behavior in [Operations and recovery](operations-and-recovery.md),
component changes in [Architecture](architecture.md), and release changes in
[Releases](releases.md). Summaries elsewhere should link here rather than copy
sections that can drift. Keep safety warnings visible before mutation-enabled
commands and use relative links so pages work on GitHub and in a checkout.
