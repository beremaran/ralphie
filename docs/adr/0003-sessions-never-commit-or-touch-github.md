---
status: superseded by ADR-0005
---

# Sessions never commit, push, or mutate GitHub, even under `/implement`

Matt's `/implement` ends with "commit your work", and `/to-tickets` publishes its
own issues. Inside Ralphie, a skill overlay overrides both: sessions only edit
the working tree or return structured results, and Ralphie's deterministic code
stages, commits, pushes, labels, comments and publishes. This keeps checkpoint
restore, the binding between the reviewed tree and the delivered commit, and the
non-force push checks under Ralphie's control. `/code-review` still needs
commits to diff against, so Ralphie creates local candidate commits on top of the
checkpoint and squashes them into one created commit before delivery.

> **Superseded in part by ADR-0005.** Sessions now inherit GitHub and git
> authority, so "never" is a prompt instruction, not an enforced boundary. The
> candidate-commit and verified-delivery design above still applies.
