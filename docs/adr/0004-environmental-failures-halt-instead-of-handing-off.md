---
status: accepted
---

# Environmental failures halt the run instead of handing off

Hand-offs are always on: anything that needs a human moves the issue to
`needs-info` or `ready-for-human`, and a handed-off issue never re-enters the
queue unchanged. A usage limit, a provider outage or an expired harness login is
different. Nothing is wrong with the issue, and handing it off would ask a human
to look at an issue that only needed a rerun. It would also burn through the
rest of the queue, since every later issue hits the same wall.

So a failure the harness classifies as `transient` or `auth`
(`HALTING_KINDS` in `src/harness/failure-classification.ts`) halts the run
instead. The issue's checkout is restored, the issue is recorded as `deferred`,
nothing on GitHub changes, no later issue starts, and the process exits `75`
(`EX_TEMPFAIL`). Every other failure still ends in a hand-off.

This adds a third way a run can end, beyond success and hand-off, so anything
that reads the exit code must treat `75` as "retry later" rather than as a
failure. The outcome is documented in
[Operations and recovery](../operations-and-recovery.md).
