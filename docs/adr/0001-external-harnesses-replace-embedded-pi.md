---
status: accepted
---

# External harnesses replace the embedded pi SDK

Ralphie no longer embeds an agent SDK. It drives the user's own installed harness
(Claude Code, Codex, pi, and later OpenCode) as a headless child process, chosen
per role, so users keep their existing logins, models and tooling. In exchange
Ralphie gives up in-process control of tools and models: it can no longer enforce
a tool policy, so safety moves to the session environment (no GitHub credentials,
disabled push URL), a fail-closed unchanged-tree check after read-only sessions,
and zod validation of every structured result, using native schema output where
the harness has it and a resume-with-error JSON fallback where it does not.

An earlier multi-harness layer (OpenCode server plus a six-kind harness
contract) was replaced by the in-process pi runtime in September 2026. That was
a maintainer preference, not a technical failure of driving external harnesses,
so it carries no lesson against this decision.

## Consequences

- Approval is a per-harness capability, not a Ralphie feature. Harnesses with no
  sandbox or approval system (OpenCode, pi) can only run editing roles with an
  explicit `approval: yolo`.
- The in-TUI model picker is gone; models are configured per harness and role.

> **Update:** ADR-0005 removed the credential and push-URL isolation named above.
> The read-only check and structured-result validation remain.
