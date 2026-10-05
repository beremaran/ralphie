# Ralphie

Ralphie turns open GitHub issues into reviewed commits on a branch. Its delivery
language distinguishes a locally created commit from a commit confirmed at the
remote branch.

## Language

### Harnesses and sessions

**Harness**:
An external coding-agent program (such as Claude Code, Codex, OpenCode, or pi)
that Ralphie drives headlessly to do reasoning and edits.
_Avoid_: Agent, provider, backend

**Session**:
One headless invocation of a harness, starting from a fresh context.
_Avoid_: Agent, run, conversation

**Role**:
The purpose a session serves in the workflow, such as implementer or reviewer.
Each role is assigned a harness.
_Avoid_: Agent, profile, stage

**Skill overlay**:
Ralphie's own instructions layered on top of an unmodified vendored skill,
where Ralphie's contract departs from the skill's literal text.
_Avoid_: Patch, fork

### Issues

**Agent-ready issue**:
An open issue carrying the configured intake label, which by default is the
`ready-for-agent` triage label.
_Avoid_: Actionable issue, eligible issue

**Pre-flight**:
A read-only check that an agent-ready issue can be worked now and fits in one
session.
_Avoid_: Grounding, readiness check, complexity assessment

**Hand-off**:
Returning an issue to humans by moving it to a human-facing triage label with
an explanatory comment.
_Avoid_: Needs attention, notification, escalation

### Delivery

**Candidate commit**:
A local commit Ralphie creates from staged session changes so they can be
reviewed; it is squashed into the created commit and never pushed.
_Avoid_: WIP commit, review commit

**Created commit**:
A local commit that may not yet be present at the intended remote branch.

**Commit delivery**:
The delivery of an already-created commit to its intended remote branch,
including the evidence establishing whether it arrived.

**Confirmed push**:
A commit delivery for which an authoritative remote branch read matches the
created commit.

**External movement during push reconciliation**:
An authoritative remote branch result that matches neither the expected prior
commit nor the created commit.
_Avoid_: Ambiguous push (when this remote evidence is available)
