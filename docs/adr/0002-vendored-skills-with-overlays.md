---
status: accepted
---

# Matt Pocock's skills are vendored, pinned, and never patched

Ralphie's workflow runs mattpocock/skills (`triage`, `to-tickets`, `implement`,
`tdd`, `code-review`, `codebase-design`, `diagnosing-bugs`) from a copy vendored
in this repo and pinned to an upstream commit, rather than relying on whatever
the user has installed in their harness. This keeps behaviour identical across
harnesses and machines, and makes each upstream change a reviewed sync PR instead
of a silent change mid-run. Wherever Ralphie's contract departs from a skill's
text, the difference lives in a Ralphie skill overlay, never in the vendored
files, so syncing never conflicts. Ralphie's pinned copy wins over a same-named
skill in the target repository; users can point `skills.dir` at their own fork.
