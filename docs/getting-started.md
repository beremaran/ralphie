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

Ralphie expects these tools on `PATH`:

- [Bun](https://bun.sh/)
- [Git](https://git-scm.com/)
- [GitHub CLI](https://cli.github.com/)
- model credentials supported by [Pi](https://github.com/earendil-works/pi)

By default, configure Pi in `~/.pi/agent/auth.json`, or point `--pi-dir` at an
existing Pi agent directory outside the Ralphie workspace. An explicitly
supplied `--pi-dir` is operator-owned and is never removed. A static
configuration can be mounted read-only, but use a read-write mount when Pi
must update `auth.json`, `models.json`, or its model store.

For an OpenAI-compatible endpoint, set `RALPHIE_MODEL_BASE_URL` and, when
required by the provider, `RALPHIE_MODEL_API_KEY`. When `--pi-dir` is not
supplied, Ralphie creates `models.json` and `auth.json` in a private 0700
system-temporary directory with 0600 files. That directory is removed on
normal close and failed startup, and is never placed under the persistent
workspace.

For `github.com`, set `GH_TOKEN` (preferred) or `GITHUB_TOKEN` (fallback) for
noninteractive GitHub CLI authentication. Ralphie verifies the token with
`gh auth status` and reads it with `gh auth token`; interactive `gh auth login`
and a mounted GitHub CLI profile are not required. This contract covers
`github.com` only.

Your GitHub account must be able to read the target repository and its issues.
Non-dry runs also require permission to push to the selected branch and create,
update, and close issues. `--workflow pr` additionally requires permission to
create, comment on, and merge pull requests.

## Installation

### Standalone release

The standalone installer downloads and verifies the native release binary for
macOS or Linux. It uses this stable, unauthenticated repository entry point
and installs the latest release by default. Verification is mandatory: install
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

For a published installation:

```bash
bunx @beremaran/ralphie --version
```

For a source checkout, use the source entry point instead:

```bash
bun run index.ts --version
```

`ralphie --version` prints only the release version. For automation,
`ralphie --version --output json` prints a stable object containing `version`
and `commitSha`. Both forms work without a repository, GitHub credentials, or
Pi configuration. Release builds embed the immutable commit SHA supplied by
the build entry point; local builds use the documented `local` commit sentinel
when no release SHA is supplied.

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
discovers issues, and asks Pi for read-only grounding and a complexity
assessment. It may create or reset the local workspace and write run
artifacts, but it does not ask Pi to edit the repository, create commits, push,
or mutate GitHub. Dry-run also reports already-resolved and needs-attention
routes, then remains mutation-free on resume. See [Workflows](workflows.md) for
what the selected route means and [Operations and recovery](operations-and-recovery.md)
for the artifacts it leaves behind.

## Published container

The container runs as UID/GID `65532:65532` with `HOME` and its working
directory set to `/home/nonroot`. Supply credentials only at runtime and keep
Pi configuration in a separate mount from the persistent state/workspace. This
example uses a read-write bind mount because Pi may update its configuration;
use `readonly` only for a fully provisioned static configuration that does not
need Pi writes:

```bash
docker run --rm \
  --env GH_TOKEN \
  --mount type=volume,source=ralphie-state,target=/home/nonroot/.ralphie \
  --mount type=bind,source="$HOME/.pi/agent",target=/home/nonroot/.pi/agent \
  ghcr.io/beremaran/ralphie:latest owner/repository \
  --workspace /home/nonroot/.ralphie \
  --pi-dir /home/nonroot/.pi/agent \
  --dry-run --max-issues 1
```

Alternatively, omit `--pi-dir` and provide `RALPHIE_MODEL_BASE_URL` (and, when
required, `RALPHIE_MODEL_API_KEY`) at runtime; Ralphie then uses a private
system-temporary configuration directory. The image contains the GitHub CLI,
Git, Pi's shell/search tools, and CA certificates; it does not contain
credentials or credential-bearing defaults. For `github.com`, pass `GH_TOKEN`
(preferred) or `GITHUB_TOKEN` (fallback) at runtime. Authentication is
noninteractive: `gh auth login` and a mounted GitHub CLI profile are not
required.

For all available options and mode-specific commands, continue to the [CLI
reference](cli-reference.md).