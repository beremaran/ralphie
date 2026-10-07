---
status: accepted
---

# Sessions inherit GitHub and git authority

Sessions need GitHub context from linked issues, pull requests, discussion and
CI, so each inherits the GitHub and git authority available to Ralphie and may
use `gh` to read that context. Prompts instruct sessions not to create, edit,
comment on, label, close or reopen GitHub tracker content, and not to commit or
push; those instructions are not technical enforcement. We removed credential
isolation and the disabled workspace push URL because they blocked useful reads
without providing a reliable boundary against a session that ignores its
instructions. The read-only fingerprint guard, checkpoint restore and verified
non-force delivery push remain, but cannot undo an early GitHub mutation or
session push. For a hard boundary on available authority, run Ralphie under a
dedicated OS user or give it a fine-grained token scoped to the target
repository with only the required permissions. Sessions inherit those
permissions; repository scope does not make access read-only. This supersedes
ADR-0003's isolation and no-authority claims; its prompt instruction not to
mutate GitHub or commit/push and its candidate-commit delivery design remain in
force.
