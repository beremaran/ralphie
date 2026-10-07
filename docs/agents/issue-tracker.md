# Issue tracker: GitHub

Ralphie supplies the issue content in the prompt. Work from that text.

You may use the `gh` CLI to read issues, pull requests, comments and CI results.

Do not create, edit, comment on, label, close or reopen tracker items. Do not
change assignees or issue relationships. Ralphie performs every change to the tracker itself.
This rule also applies to raw GitHub API calls: specify the `GET` method in
every request; never use the API to write tracker data.

## Read-only lookups

- **Read an issue**: `gh issue view <number> --comments` for the body, labels
  and discussion.
- **List issues**: `gh issue list --state open --json number,title,body,labels,assignees,comments`
  with appropriate `--label` and `--state` filters.
- **Read a pull request**: `gh pr view <number> --comments` and
  `gh pr diff <number>`.
- **List pull requests**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`.
- **Inspect CI**: use `gh run list --commit <sha>` and `gh run view <run-id>`.
- **Inspect API-only tracker details**: use `gh api --method GET` with the
  repository and issue path. For example,
  `gh api --method GET repos/<owner>/<repo>/issues/<number> --jq .id` reads an
  issue's database id. Every API command must specify `--method GET`.

Infer the repository from `git remote -v`; `gh` resolves it automatically when
run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external
PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, use read-only `gh pr` commands to inspect them. Keep only
`authorAssociation` values of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or
`NONE` when filtering external requests; drop `OWNER`, `MEMBER`, and
`COLLABORATOR`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be
either. Resolve it with `gh pr view 42` and fall back to `gh issue view 42`.

## Skills that ask to publish tracker content

Do not publish it yourself. Ralphie owns tracker updates; describe the proposed
change in your response instead.

When a skill says to fetch a ticket, run `gh issue view <number> --comments`.

## Wayfinding lookups

Used by `/wayfinder`. A map is a single issue labelled `wayfinder:map`, holding
the Notes / Decisions-so-far / Fog body. Its child issues form the task graph.

- **Read the map and children**: use `gh issue view <number> --comments` and
  `gh issue list --state open`; follow the map's sub-issues or task list.
- **Check blockers**: inspect the issue's `Blocked by` line or use a
  read-only API `GET` to check `issue_dependencies_summary.blocked_by` when
  native issue dependencies are enabled. A ticket is unblocked when every
  blocker is closed.
- **Find the frontier**: among open children, skip issues with an open blocker
  or an assignee; the first remaining child in map order is the next candidate.

These lookups do not claim, resolve, or change the map or its children. Return
the findings to Ralphie; it owns all tracker updates.
