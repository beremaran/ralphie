# Configuration

This page is the authoritative reference for every key in Ralphie's
configuration file. For the command line, see the [CLI reference](cli-reference.md).

## File location

Ralphie reads `$XDG_CONFIG_HOME/ralphie/config.yaml`, falling back to
`~/.config/ralphie/config.yaml` when `XDG_CONFIG_HOME` is unset or empty. Pass
`--config <path>` to load a different file, for example to keep separate
configurations for experiments or CI.

Ralphie fails with a message naming the expected path when the file does not
exist, so the first run of a tool that pushes to your branch is deliberate. An
empty file is valid and means "all defaults".

The file holds no credentials. Ralphie relies on `gh` authentication
(`GH_TOKEN`/`GITHUB_TOKEN` or `gh auth login`) and on pi's own credential
store; see [Getting started](getting-started.md). The file is therefore safe
to share.

## Validation

The file is validated with a strict schema before anything runs. Unknown keys,
wrong types and invalid values are rejected with the exact path at fault:

```text
Invalid configuration (/home/me/.config/ralphie/config.yaml):
  limits.reviewRoundz: unknown key
  intake.sort: must be created, updated or comments, optionally followed by :asc or :desc
```

Keys under `repos:` that contain a slash are quoted in these paths, as they
are in `--set`.

## Precedence

Settings resolve in this order, each layer overriding the one before it:

1. Built-in defaults.
2. The top-level keys of the file.
3. The `repos:` entry matching the target repository (compared
   case-insensitively).
4. `--set` overrides.

Mappings merge key by key; lists (`intake.requireLabels`, `verify`) are
replaced, not concatenated.

## Keys

### Top level

| Key | Default | Description |
| --- | --- | --- |
| `defaultOwner` | the `gh` login | Owner given to a bare `repo` argument. Takes precedence over the authenticated `gh` user. |
| `workspace` | `~/.ralphie` | Root directory for repository checkouts and run artifacts. The workspace is removed before preparation and after a successful run. Use a path dedicated to Ralphie. |
| `intake` | see below | Which open issues Ralphie works. |
| `labels` | see below | Your tracker's names for Matt Pocock's five triage roles. |
| `limits` | see below | Attempt and depth budgets. |
| `repos` | none | Per-repository overrides keyed by `owner/repo`. |

`defaultOwner` applies only at the top level, and `--set defaultOwner=<owner>`
overrides it for one run.

### `intake`

| Key | Default | Description |
| --- | --- | --- |
| `requireLabels` | `[]` | Only issues carrying **all** of these labels are processed. |
| `sort` | `created:asc` | `created`, `updated` or `comments`, optionally followed by `:asc` or `:desc`. |

### `labels`

Maps each of Matt Pocock's canonical triage roles to the label your tracker
uses. Every role defaults to its own name.

| Key | Default |
| --- | --- |
| `needs-triage` | `needs-triage` |
| `needs-info` | `needs-info` |
| `ready-for-agent` | `ready-for-agent` |
| `ready-for-human` | `ready-for-human` |
| `wontfix` | `wontfix` |

> [!NOTE]
> The label map is validated and resolved but not consumed by the workflow
> yet; it takes effect when agent-ready intake and hand-offs land.

### `limits`

All values are positive integers.

| Key | Default | Description |
| --- | --- | --- |
| `implementationAttempts` | `3` | Implementation attempts allowed when sessions leave an unresolved empty diff. |
| `maxDecompositionDepth` | `3` | Maximum generated-child lineage depth. Reaching the ceiling leaves the issue open, records needs attention, and continues independent work. |
| `reviewRounds` | `5` | Review rounds per issue. |
| `verificationFixes` | `5` | Verification fix attempts per issue. |

> [!NOTE]
> `reviewRounds` and `verificationFixes` are validated and resolved but not
> consumed yet; both budgets are currently fixed at `5` until the review and
> fix loop is reworked.

### `repos.<owner/repo>`

An entry overrides any of `workspace`, `intake`, `labels` and `limits` for that
repository only, and additionally accepts:

| Key | Default | Description |
| --- | --- | --- |
| `branch` | `main`, otherwise `master` | Branch pushed directly after verified delivery. |
| `verify` | `[]` | Deterministic gate run after changes are staged. Commands run in order through `/bin/sh` in the checkout, each under a 30-minute deadline. When empty, the gate is skipped and review proceeds on the staged diff alone. |

Repository keys must look like `owner/repo`, and two keys that differ only by
case are rejected.

## Overriding for one run with `--set`

`--set path=value` takes the same dotted paths as the file and is repeatable.
Quote a segment that contains a slash or a dot:

```bash
ralphie owner/repo --set limits.reviewRounds=3
ralphie owner/repo --set 'repos."owner/repo".branch=develop'
ralphie owner/repo --set 'intake.requireLabels=["backend"]'
```

The value is parsed as JSON when it is valid JSON (numbers, booleans, lists)
and used as literal text otherwise. A `--set` override beats every other layer,
including the matching `repos:` entry, and is validated like the file: a typo
names its path. Overrides under `repos."<other/repo>"` are validated but only
apply when that repository is the target.

## Example

```yaml
defaultOwner: acme

intake:
  requireLabels: [backend]
  sort: updated:desc

labels:
  ready-for-agent: afk

limits:
  implementationAttempts: 2

repos:
  acme/widgets:
    branch: develop
    verify:
      - bun run check
    limits:
      maxDecompositionDepth: 2
```

With this file, `ralphie widgets` targets `acme/widgets`, pushes to `develop`
and runs `bun run check` after each staging.
