# Unify the Pipeline delivery lifecycle

The Pipeline mode had command-owned resume, dry-run, state persistence, and a separate delivery loop, which made the lifecycle contract harder to reason about and test. We now expose one Pipeline delivery lifecycle with a discriminated live/dry-run/resume entry point, lifecycle-owned state reconciliation, and semantic event fan-out; the command remains responsible for authentication, workspace cleanup, OpenCode lifetime, and exit semantics while the existing version-one state schema and safety outcomes remain stable.
