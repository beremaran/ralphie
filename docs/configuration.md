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

There is no built-in fallback: when no file exists, Ralphie stops at startup
and names the path it looked for. An empty file is valid and means "all
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
intake:
  requireLabels: [bug]
  sort: created:asc
labels:
  needs-triage: needs-triage
  needs-info: needs-info
  ready-for-agent: ready-for-agent
  ready-for-human: ready-for-human
  wontfix: wontfix
limits:
  implementationAttempts: 3
  reviewRounds: 5
  verificationFixes: 5
  maxDecompositionDepth: 3
notifications:
  enabled: false
repos:
  acme/api:
    branch: develop
    verify:
      - bun run check
    intake:
      requireLabels: [bug, backend]
```

Every key is optional. The values above are the defaults, except
`defaultOwner`, `branch`, `verify`, and `notifications.label`, which have none.

### Top level

| Key | Default | Description |
| --- | --- | --- |
| `defaultOwner` | none | Owner added to a bare `repo` argument. Top level only. |
| `workspace` | `~/.ralphie` | Root directory for repository checkouts and run artifacts. Ralphie removes the workspace recursively before preparation and after a successful run, subject to protected-path checks; use a path dedicated to Ralphie (see [Safety](safety.md#workspace-risk)). Overridable per repository. |
| `repos` | none | Per-repository overrides, keyed by `owner/repo`. Top level only. |

### `intake`

| Key | Default | Description |
| --- | --- | --- |
| `intake.requireLabels` | `[]` | An issue must carry every listed label to enter the queue (AND filter). Temporary: replaced when intake moves to agent-ready issues. |
| `intake.sort` | `created:asc` | Queue order: `created`, `updated`, or `comments`, optionally suffixed `:asc` or `:desc`. Without a suffix the order is ascending. |

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

### `limits`

All limits are positive integers.

| Key | Default | Description |
| --- | --- | --- |
| `limits.implementationAttempts` | `3` | Implementation attempts allowed when sessions leave an unresolved empty diff. |
| `limits.reviewRounds` | `5` | Review rounds before the issue escalates to decomposition. At most `20`. |
| `limits.verificationFixes` | `5` | Repair attempts allowed after a failing `verify` command. |
| `limits.maxDecompositionDepth` | `3` | Maximum generated-child lineage depth. Reaching it leaves the issue open, records needs attention, and continues independent work. |

### `notifications`

Temporary opt-in, kept until hand-offs replace it.

| Key | Default | Description |
| --- | --- | --- |
| `notifications.enabled` | `false` | Publish needs-attention outcomes as an idempotent GitHub comment. |
| `notifications.label` | none | Label added to those notifications; requires `notifications.enabled: true`. |

### Repository entries

Each `repos."owner/repo"` entry accepts `workspace`, `intake`, `labels`,
`limits`, and `notifications` (overriding the top level for that repository
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
| `--notify-needs-attention` | `notifications.enabled` |
| `--needs-attention-label` | `notifications.label` |
