# Configuration

Ralphie reads its settings from a YAML file instead of command-line flags. This
page is the authoritative reference for the file location, every key, its
default, and how settings are layered. Return to the
[documentation index](README.md) for reading paths, and see the
[CLI reference](cli-reference.md) for the few options that remain on the
command line.

## File location

Ralphie loads the first of these that applies:

1. The path given with `--config <path>`. A missing file is an error.
2. `$XDG_CONFIG_HOME/ralphie/config.yaml`, when `XDG_CONFIG_HOME` is an
   absolute path.
3. `~/.config/ralphie/config.yaml`.

There is no built-in fallback: when no file exists, Ralphie stops at startup,
names the path it looked for, and points at `ralphie init`, which writes a
starter file. An empty file is valid and means "all
defaults".

The file is validated with a strict schema before anything else runs. Unknown
keys, wrong types, and unknown values fail with the offending path, for
example `limits.reviewRounds: Invalid input: expected number, received string`. Errors caused
by a `--set` override are marked `(from --set)`.

## Choosing a repository

Ralphie is invoked as `ralphie [owner/]repo`. Nothing is inferred from the
current directory.

| Argument | Resolved to |
| --- | --- |
| `owner/repo` or a GitHub HTTPS/SSH clone URL | Used as given. |
| `repo` | `defaultOwner/repo`, else the login `gh` is authenticated as (`gh api user`, honoring `GH_TOKEN`/`GITHUB_TOKEN`). |

## Layering

For the selected repository, settings are layered from lowest to highest
precedence:

1. Built-in defaults.
2. Top-level settings in the file.
3. The matching `repos."owner/repo"` entry. Repository keys match
   case-insensitively.
4. `--set path=value` overrides, in command-line order.

Mappings merge key by key. Lists and scalars replace the lower layer
entirely: a `repos` entry that sets `intake.requireLabels` does not add to the
top-level list.

### `--set path=value`

`--set` is repeatable. The path is dotted; a key containing dots or a slash
is double-quoted, and the value is read as YAML:

```bash
ralphie acme/api \
  --set limits.reviewRounds=3 \
  --set 'intake.requireLabels=[bug, backend]' \
  --set 'repos."acme/api".branch=develop'
```

A `--set` path under `repos."owner/repo"` applies to that repository like
any file entry. Quote the whole argument for your shell when the value
contains spaces or brackets.

## Keys

```yaml
defaultOwner: acme
workspace: ~/.ralphie
approval: safe
harnesses:
  claude:
    model: opus
    effort: high
    approval: safe
roles:
  default: claude
  reviewer:
    harness: claude
    model: sonnet
intake:
  requireLabels: [bug]
  sort: created:asc
triage:
  enabled: false
labels:
  needs-triage: needs-triage
  needs-info: needs-info
  ready-for-agent: ready-for-agent
  ready-for-human: ready-for-human
  wontfix: wontfix
skills:
  dir: ./my-skills
limits:
  implementationAttempts: 3
  reviewRounds: 5
  verificationFixes: 5
  maxDecompositionDepth: 3
  sessionTimeoutMinutes:
    edit: 60
    readOnly: 15
  maxBudgetUsd: 5
repos:
  acme/api:
    branch: develop
    verify:
      - bun run check
    intake:
      requireLabels: [bug, backend]
```

Every key is optional. The values above are the defaults, except
`defaultOwner`, `branch`, `verify`, `skills.dir`, and `limits.maxBudgetUsd`, which have none.

### Top level

| Key | Default | Description |
| --- | --- | --- |
| `defaultOwner` | none | Owner added to a bare `repo` argument. Top level only. |
| `approval` | `safe` | Approval mode of the editing roles (`implementer`, `fixer`): `safe` or `yolo`. Overridable per repository and per harness. See [Approval modes](safety.md#approval-modes). |
| `workspace` | `~/.ralphie` | Root directory for repository checkouts and run artifacts. Ralphie deletes this directory; use a path dedicated to Ralphie (see [Workspace risk](safety.md#workspace-risk)). Overridable per repository. |
| `repos` | none | Per-repository overrides, keyed by `owner/repo`. Top level only. |

### `harnesses` and `roles`

Every agent session runs as a role on a harness. The harnesses are `claude`
(Claude Code), `codex`, `pi`, and `opencode`. Sessions run through the
harness's own command-line program, which brings its own login and
credentials; Ralphie stores none.

`harnesses.<name>` sets the defaults for sessions on that harness:

| Key | Default | Description |
| --- | --- | --- |
| `harnesses.<name>.model` | harness default | Model passed to the harness. |
| `harnesses.<name>.effort` | harness default | Reasoning effort passed to the harness. |
| `harnesses.<name>.approval` | top-level `approval` | Approval mode for editing roles that run on this harness. |
| `harnesses.<name>.experimental` | `false` | Opt in to a harness whose adapter has not been verified against a live model. Currently only `opencode` needs it: startup refuses any role assigned to OpenCode until `harnesses.opencode.experimental: true` is set. Other harnesses ignore it. |

`roles` assigns a harness to each role. A value is a harness name, or a
mapping `{ harness, model, effort }` whose `model` and `effort` override the
harness defaults for that role.

| Key | Default | Description |
| --- | --- | --- |
| `roles.default` | `claude` | Harness for every role without its own assignment. |
| `roles.reviewer` | `roles.default` | Assignment both `standards-reviewer` and `spec-reviewer` inherit. |
| `roles.triager`, `preflight`, `implementer`, `resolution-verifier`, `decomposer` | `roles.default` | Per-role assignment. |
| `roles.standards-reviewer`, `roles.spec-reviewer` | `roles.reviewer`, else `roles.default` | Per-role assignment. |
| `roles.fixer` | the resolved `implementer` | Per-role assignment. |

The sessions map onto the roles as follows: AFK triage is the `triager`; the
pre-flight session and hand-off confirmation are the `preflight`;
implementation is the `implementer` (it also writes the commit message);
repair sessions are the `fixer`; the review gate runs the `standards-reviewer`
and the `spec-reviewer`; issue-resolution checks are the `resolution-verifier`;
and decomposition is the `decomposer`.

Startup checks each assigned harness (the `triager` only when
`triage.enabled` is true) by running its `--version`. A harness older than the
minimum below stops the run with an error naming the harness and the version it
needs. Output that contains no readable version only produces a warning.

| Harness | Minimum version |
| --- | --- |
| Claude Code (`claude`) | 2.1.289 |
| Codex (`codex`) | 0.160.0 |
| OpenCode (`opencode`) | 2.0.22 |
| pi (`pi`) | 1.0.2 |

Only the editing roles (`implementer`, `fixer`) may edit the checkout; the
others run read-only. How the editing roles are approved is described under
[Approval modes](safety.md#approval-modes), and each session's time limit is
under `limits.sessionTimeoutMinutes`. `pi` and `opencode` editing roles need
`approval: yolo`.

### `intake`

| Key | Default | Description |
| --- | --- | --- |
| `intake.requireLabels` | `[]` | An issue must carry every listed label to enter the queue (AND filter). Added to the mandatory `labels.ready-for-agent` label. Children created by decomposition inherit the parent's labels listed here, plus the agent-ready label (see [Decomposition](workflows.md#decomposition-workflow)). |
| `intake.sort` | `created:asc` | Queue order: `created`, `updated`, or `comments`, optionally suffixed `:asc` or `:desc`. Without a suffix the order is ascending. |

### `triage`

| Key | Default | Description |
| --- | --- | --- |
| `triage.enabled` | `false` | Run AFK triage before the queue. See [AFK triage](workflows.md#afk-triage). |

### `labels`

Maps Matt Pocock's five canonical triage roles to the label names used in the
tracker. Each value is a non-empty label name and defaults to the role's own
name. Two roles may not share one label (compared case-insensitively).

| Key | Default |
| --- | --- |
| `labels.needs-triage` | `needs-triage` |
| `labels.needs-info` | `needs-info` |
| `labels.ready-for-agent` | `ready-for-agent` |
| `labels.ready-for-human` | `ready-for-human` |
| `labels.wontfix` | `wontfix` |

### `skills`

| Key | Default | Description |
| --- | --- | --- |
| `skills.dir` | the skills bundled with Ralphie | Directory whose subdirectories are skills (each holds a `SKILL.md`). Relative paths resolve against the current directory. |

Before each session Ralphie copies these skills into the harness's project
skills directory (`.claude/skills`, `.agents/skills` for Codex, `.pi/skills`,
`.opencode/skills`). A repository skill with the same name is set aside for the
session and restored afterwards, so Ralphie's copy wins while other repository
skills stay available. Everything injected is added to the checkout's
`.git/info/exclude`, and is removed again when the session ends. Sessions that
overlap in one working directory (the parallel reviewers) share one injection:
the first prepares the checkout, and the last to finish restores it. If the
repository has no `docs/agents/issue-tracker.md` or
`docs/agents/triage-labels.md`, Ralphie generates them for the session: the
label table comes from `labels`, and the tracker doc says issue content is in
the prompt, permits `gh` reads, and instructs sessions not to mutate the
tracker. Committed versions always win.

### `limits`

All limits are positive; counts are integers.

| Key | Default | Description |
| --- | --- | --- |
| `limits.implementationAttempts` | `3` | Implementation attempts allowed when sessions leave an unresolved empty diff or an implementer session times out. After the last attempt the issue is handed off `ready-for-human`. |
| `limits.reviewRounds` | `5` | Review rounds before the issue escalates to decomposition. At most `20`. |
| `limits.verificationFixes` | `5` | Repair attempts allowed after a failing `verify` command. |
| `limits.sessionTimeoutMinutes.edit` | `60` | Wall-clock limit of one session in an editing role. Exceeding it kills the session's process group and counts as a failed attempt. |
| `limits.sessionTimeoutMinutes.readOnly` | `15` | The same limit for read-only roles. |
| `limits.maxBudgetUsd` | none | Spend cap in US dollars for each session. Only Claude Code enforces it; Codex, pi and OpenCode ignore it, and startup warns for every assigned harness that cannot. |
| `limits.maxDecompositionDepth` | `3` | Maximum generated-child lineage depth. Reaching it hands the issue off as `ready-for-human` and continues independent work. |

### Repository entries

Each `repos."owner/repo"` entry accepts `workspace`, `approval`, `harnesses`, `roles`,
`intake`, `triage`, `labels`, `skills`, and `limits` (overriding the top level for that repository
only) plus two keys that exist only here:

| Key | Default | Description |
| --- | --- | --- |
| `branch` | `main`, otherwise `master` | Base branch that verified work is pushed to directly. |
| `verify` | `[]` | Deterministic gate commands run in order after changes are staged, each under a 30-minute deadline. When empty, the gate is skipped and review proceeds on the staged diff alone. |

## Removed flags

Each former flag now fails with an error naming its replacement.

| Former flag | Config key |
| --- | --- |
| `-b`, `--branch` | `repos."owner/repo".branch` |
| `--verify-command` | `repos."owner/repo".verify` |
| `--issue-label` | `intake.requireLabels` |
| `--issue-sort` | `intake.sort` |
| `--implementation-attempts` | `limits.implementationAttempts` |
| `--max-decomposition-depth` | `limits.maxDecompositionDepth` |
| `--workspace` | `workspace` |
| `--model` | `harnesses.<harness>.model` or `roles.<role>.model` |
| `--thinking` | `harnesses.<harness>.effort` or `roles.<role>.effort` |
| `--notify-needs-attention` | none: hand-offs are always on |
| `--needs-attention-label` | `labels.ready-for-human` |
