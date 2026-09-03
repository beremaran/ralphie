# Getting started

This page is for a new operator setting up Ralphie and performing the first
safe validation. It is the authoritative guide to prerequisites, installation,
credential setup, verification, and the first dry run. Return to the
[documentation index](README.md) for other task paths.

> [!CAUTION]
> Ralphie defaults to the `lgtm` workflow, which commits approved work and
> pushes directly to the selected branch. Ralphie is pre-1.0. The commands on
> this page use `--dry-run`; read the [safety model](safety.md) before enabling
> mutations.

## Prerequisites and authentication

The required local tools depend on how Ralphie is installed:

- A verified standalone binary needs Git, the [GitHub CLI](https://cli.github.com/),
  a POSIX shell, and a running [OpenCode](https://opencode.ai/v2/docs/) server
  (`opencode2 serve`), but does not need [Bun](https://bun.sh/) to execute.
- The published JavaScript package and a source checkout need Bun to run.
- Building Ralphie from source also needs Bun.

The standalone installer additionally needs `curl`, the Sigstore CLI, and a
SHA-256 utility (`sha256sum` or `shasum`).

Ralphie never starts the OpenCode server itself. Start it separately before
running Ralphie (for example `opencode2 serve`), then point Ralphie at it.
By default Ralphie discovers the local background service automatically. To
use an explicit server, pass `--opencode-url <url>` (or set `OPENCODE_URL`)
and, when the server requires one, `--opencode-token <token>` (or set
`OPENCODE_TOKEN` in the environment).

The OpenCode server owns model credentials and tool permissions. For
unattended runs, configure its permissions to allow `read`, `edit`, and
`shell` work inside the checkout while denying mutating Git and GitHub
commands (`git commit/push/branch/checkout/switch/worktree/reset/clean` and
`gh *`). Ralphie additionally instructs agents never to run those commands,
auto-rejects them when they surface as pending approvals, and fails the task
when post-task verification finds the checkout was mutated anyway.

For interactive GitHub authentication, run `gh auth login` and verify the
selected account with `gh auth status`. For unattended runs, set `GH_TOKEN`
(preferred) or `GITHUB_TOKEN` (fallback) in the process environment. The
credential is supplied as an input and does not need to be printed or exposed;
a mounted GitHub CLI profile is not required when an environment token is
provided. This contract covers `github.com` only.

Your GitHub account must be able to read the target repository and its issues.
Non-dry runs also require permission to push to the selected branch and create,
update, and close issues. `--workflow pr` additionally requires permission to
create, comment on, and merge pull requests.

## Installation

### Standalone release

The standalone installer downloads and verifies the native release binary for
macOS or Linux. It uses this stable, unauthenticated repository entry point
and installs the latest release by default. The installed binary runs without
Bun. Verification is mandatory: install
the Sigstore CLI (`sigstore`) and ensure either `sha256sum` (Linux) or `shasum`
(macOS) is available on `PATH` before running it. The installer has no unsigned
or checksum-only fallback:

```bash
curl -fsSL https://raw.githubusercontent.com/beremaran/ralphie/main/scripts/install.sh | sh
```

To download the script before running it, save it locally so you can inspect it
first:

```bash
curl -fsSL https://raw.githubusercontent.com/beremaran/ralphie/main/scripts/install.sh \
  -o install-ralphie.sh
sh install-ralphie.sh
```

With no positional argument, the installer creates the destination if needed
and installs exactly to `$HOME/.local/bin`. The optional positional argument is
a destination directory; for example, this installs to `/usr/local/bin` when
that directory is writable:

```bash
curl -fsSL https://raw.githubusercontent.com/beremaran/ralphie/main/scripts/install.sh | sh -s -- /usr/local/bin
```

To pin a release, set `RALPHIE_VERSION` to either `0.1.0` or `v0.1.0` on the
installer process:

```bash
curl -fsSL https://raw.githubusercontent.com/beremaran/ralphie/main/scripts/install.sh | RALPHIE_VERSION=0.1.0 sh
```

Add the installation directory to `PATH` persistently, then load the change in
the current shell before verifying the command:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.profile"
. "$HOME/.profile"
ralphie --version
```

If your shell uses a different startup file, add the same `export PATH=...`
line there instead.

The installer verifies the signed checksum manifest against the release tag,
workflow, GitHub OIDC issuer, source event, and tag commit before replacing the
binary. Missing verification tools or any failed metadata, signature, or
checksum check leave an existing installation untouched. See the [release
trust policy](releases.md#release-checksum-trust-policy) for the complete
verification contract.

### Homebrew

The canonical repository is also a public custom tap. Add it explicitly, then
install the formula without GitHub credentials:

```bash
brew tap beremaran/ralphie https://github.com/beremaran/ralphie
brew install beremaran/ralphie/ralphie
ralphie --version
```

The formula selects the matching macOS or Linux, arm64 or x64 release asset,
verifies its release checksum, and installs it under the executable name
`ralphie`.

### Published package

Use Bun's package runner to run the latest published version without a global
installation:

```bash
bunx @beremaran/ralphie --version
```

The `@beremaran` scope is intentional. Do not substitute the unrelated
unscoped npm package named `ralphie`; use `@beremaran/ralphie` for this CLI.

### Source checkout

For development or to run the current checkout instead of a standalone release:

```bash
git clone https://github.com/beremaran/ralphie.git
cd ralphie
bun install --frozen-lockfile
bun run index.ts --version
```

## Verify the installation

For a published JavaScript installation (which requires Bun):

```bash
bunx @beremaran/ralphie --version
```

For a verified standalone installation (which does not require Bun):

```bash
ralphie --version
git --version
gh --version
gh auth status
```

For a source checkout, use the source entry point instead (Bun required):

```bash
bun run index.ts --version
```

`ralphie --version` prints only the release version. For automation,
`ralphie --version --output json` prints a stable object containing `version`
and `commitSha`. Both forms work without a repository, GitHub credentials, or
OpenCode configuration. Release builds embed the immutable commit SHA supplied by
the build entry point; local builds use the documented `local` commit sentinel
when no release SHA is supplied.

## Target-repository verification dependencies

Ralphie runs deterministic verification commands in the target checkout through
`/bin/sh`. If the target has a `package.json` `check` script, Ralphie defaults
to `bun run check`; otherwise provide one or more `--verify-command` values.
The tools used by that command belong to the target repository's contract, not
Ralphie's standalone runtime. For example, a standalone run may still need Bun
if the target's check uses Bun, and a Docker run needs a target-specific image
or another available runtime if its check needs a tool not included there.

## First dry run

Preview one issue in a repository you control:

```bash
bunx @beremaran/ralphie owner/repository --dry-run --max-issues 1
```

When running from source, use the source entry point instead:

```bash
bun run index.ts owner/repository --dry-run --max-issues 1
```

This performs authentication and Git preflight, prepares a clean checkout,
discovers issues, and asks OpenCode for read-only grounding and a complexity
assessment. It may create or reset the local workspace and write run
artifacts, but it does not ask OpenCode to edit the repository, create commits, push,
or mutate GitHub. Dry-run also reports already-resolved and needs-attention
routes, then remains mutation-free on resume. See [Workflows](workflows.md) for
what the selected route means and [Operations and recovery](operations-and-recovery.md)
for the artifacts it leaves behind.

## Published container

The container runs as UID/GID `65532:65532` with `HOME` and its working
directory set to `/home/nonroot`. Supply credentials only at runtime. The
OpenCode server runs outside the container; reach it over HTTP:

```bash
docker run --rm \
  --env GH_TOKEN \
  --env OPENCODE_URL \
  --mount type=volume,source=ralphie-state,target=/home/nonroot/.ralphie \
  ghcr.io/beremaran/ralphie:latest owner/repository \
  --workspace /home/nonroot/.ralphie \
  --dry-run --max-issues 1
```

When the server requires a token, also pass `--env OPENCODE_TOKEN`. The image
contains the GitHub CLI, Git, a POSIX shell, and CA certificates; it does not
contain Bun, credentials, or credential-bearing defaults. For `github.com`,
pass `GH_TOKEN` (preferred) or `GITHUB_TOKEN` at runtime. The container smoke
check is:

```bash
docker run --rm --env GH_TOKEN --entrypoint gh \
  ghcr.io/beremaran/ralphie:latest auth status
```

Authentication inputs are noninteractive; do not print or expose the
credential. OpenCode configuration may instead be provided through
`OPENCODE_URL` and, when required, `OPENCODE_TOKEN`.

For all available options and mode-specific commands, continue to the [CLI
reference](cli-reference.md).