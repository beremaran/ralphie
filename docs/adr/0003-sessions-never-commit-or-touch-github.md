---
status: superseded by ADR-0005
---

# Sessions never commit, push, or mutate GitHub, even under `/implement`

Matt's `/implement` ends with "commit your work", and `/to-tickets` publishes its
own issues. This decision recorded the original contract: a skill overlay
instructed sessions to edit the working tree or return structured results, while
Ralphie's deterministic code staged, committed, pushed, labelled, commented and
published. That kept checkpoint restore, the binding between the reviewed tree
and the delivered commit, and the non-force push checks under Ralphie's control.
`/code-review` still needs commits to diff against, so Ralphie creates local
candidate commits on top of the checkpoint and squashes them into one created
commit before delivery.

ADR-0005 supersedes this decision in part. Sessions now inherit GitHub and git
authority and may read through `gh`; the credential isolation and disabled push
URL are gone. The prompt instruction not to mutate GitHub or commit/push remains,
but it is not technically enforced. Ralphie's candidate-commit and verified
delivery workflow remains in force.
