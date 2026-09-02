# Releases and compatibility

This page is for release maintainers and downstream consumers. It is the
authoritative contract for version compatibility, release validation, native
and container artifacts, Homebrew updates, and checksum trust. Return to the
[documentation index](README.md) for other task paths. The [public distribution
topology](public-distribution.md) defines the canonical repository and endpoint
ownership used by this process.

Ralphie follows [Semantic Versioning](https://semver.org/). Until 1.0, minor
releases may change the CLI or persisted state schema; patch releases should
remain backward compatible. Release candidates must pass `bun run check` and
document notable changes in [`CHANGELOG.md`](../CHANGELOG.md).

## Release workflow

The release workflow accepts only strict tags of the form
`v<major>.<minor>.<patch>`, with numeric components that have no leading zeroes
(`v0.1.0` is valid). Prerelease and build suffixes are not accepted. The tag
version must exactly match `package.json` before artifacts are built. Every run
resolves the tag to its immutable commit before building; a manual dispatch
must be started from the matching protected `version` tag and provide its full
40-character lowercase commit `ref`. A mismatched ref fails before release or
registry publication rather than falling back to the default branch.

Both validation gates run through checked-in executable seams so the exact
production checks can be exercised deterministically without GitHub or
credentials: `scripts/validate-release-context.ts` enforces the stable-only
grammar, protected-tag, and event/ref resolution above (outputting the
validated `version`, `tag`, `source_ref`, and `dry_run`);
`scripts/validate-npm-context.ts` enforces the prerelease-capable SemVer
grammar plus the exact scoped `package.json` name/version match for npm
publication. The gates are covered by `bun test tests/release`.

The repository must enforce that binding with an active tag ruleset covering
`v*`. Configure **Settings → Rules → Rulesets** to target tags matching `v*`,
restrict both tag updates and deletions, and configure no bypass actors. The
workflow requires the triggering ref to report as protected before it builds;
this protection, rather than a non-atomic API recheck, closes the check/use
race between validation and publication.

Manual dispatches default to `dry_run: true`. Every validated release run
first stages an immutable package input artifact named
`ralphie-package-<version>`. That artifact contains only
`beremaran-ralphie-<version>.tgz` and the byte-for-byte checked-in
`scripts/install.sh`; the package is built with the validated commit and
canonical version, and its packed manifest, allowlist, and embedded `--version
--output json` metadata are checked before upload. The installer is checked for
its release-tag API, checksum, Sigstore-bundle, and commit references and is
never replaced with a host-specific binary or a moving-branch download. The
staging job has no npm or GitHub publication step. Every validated release run
builds and smoke-tests `linux/amd64` and `linux/arm64` container candidates
without logging into GHCR or pushing public tags. Each platform is staged as
an immutable `actions/upload-artifact@v4` artifact named
`ralphie-container-candidate-<version>-<arch>`. Native targets are likewise
staged as `ralphie-<version>-<target>` artifacts containing the renamed
executable and its `<executable>.sha256` checksum. Each leg passes its
canonical target to Bun's compile target input (rather than renaming a host
build) and validates the resulting executable header before staging. After all
four native legs succeed, the aggregation job downloads those exact versioned artifacts, rejects
missing, extra, duplicate, and cross-version files, requires each staged binary to be a
non-empty executable (rejecting stripped permission bits), and recomputes each binary
checksum against its sidecar. Native builds use `macos-14` for
`darwin-arm64`, `macos-15-intel` for `darwin-x64`, `ubuntu-24.04-arm` for
`linux-arm64`, and `ubuntu-24.04` for `linux-x64`; each leg verifies both the
host and the compiled binary's OS, `file` format, and architecture (using
`otool` and `lipo` on macOS). The staging upload is immutable and fails if a
rerun attempts to overwrite an existing target artifact. It stages the immutable
`ralphie-release-metadata-<version>` bundle containing the deterministic
`release-metadata.json` contract `ralphie.release-metadata.v1` (exact tag,
normalized version, validated commit, and sorted binary names and SHA-256
values), the four binaries, their `.sha256` sidecars, and `SHA256SUMS`. The
publisher downloads only that exact bundle, verifies it, and never
reconstructs release metadata or uses a broad native-asset glob. Its `ralphie-container-<arch>.metadata.json`
uses the
`ralphie.container-candidate.v1` contract and records the validated
`source_ref`, platform, OCI archive name and SHA-256, BuildKit image
manifest `digest`, and OCI version/revision labels; the final publisher
must verify those fields before promotion. Before the contract is written,
staging also binds the recorded BuildKit digest to the OCI archive's own
`index.json` entry: a single-platform export has exactly one manifest
descriptor whose digest must be the same lowercase `sha256:<64 hex>` value,
so the promotion input and the persisted digest cannot drift. The canonical GHCR tag is the
normalized package version without `v` (for example, `0.1.0`). The publisher
also emits exactly four deterministic SPDX 2.3 JSON SBOMs in `release-assets`:
`ralphie-<target>.sbom.spdx.json`. The checked-in `scripts/create-sboms.ts`
wrapper runs only after the final renamed binaries and checksum manifest are
present. It validates each document with the pinned Ajv 8.17.1 dependency
against the checked-in SPDX 2.3 JSON schema and release identifier profile. It
binds each document to the validated tag, commit, target, final binary bytes
and size, checked-out source and `bun.lock`, build inputs, Bun and build-tool
versions, and the generator version. It rejects incomplete, cross-release,
duplicate, or digest-mismatched inputs. The publisher then creates four
independent GitHub build-provenance attestations, each subjecting exactly one
final path (`release-assets/ralphie-darwin-arm64`, `release-assets/ralphie-darwin-x64`,
`release-assets/ralphie-linux-arm64`, or `release-assets/ralphie-linux-x64`) with
the immutable `actions/attest-build-provenance` action revision.
`attestation-subjects.json` records each final path and freshly computed
SHA-256 together with the validated tag, commit, release workflow, Bun and
build-tool versions, and build command, so each subject can be checked against
the released bytes. Before creating a release handle, the publisher requires
exactly four final binaries and exactly one matching SPDX document per target,
checks every SBOM's tag/version/commit and binary digest against the bytes in
`release-assets`, and verifies exactly one attestation for each digest. The
GitHub attestation API response must contain exactly one bundle, and the
verified provenance predicate must identify the current release workflow run.
`gh attestation verify` must also validate the release workflow, protected tag,
commit, repository, and Actions OIDC issuer. Missing, duplicate, stale, or
mismatched SBOMs and attestations fail closed before any release is
created. Attestation and signing complete before the publisher creates a
release handle; any missing or failed attestation stops publication.
The minor
version, `latest` for stable releases only, and `sha-<commit>` are explicit
aliases. A dry run skips GitHub Release and GHCR publication. A normal tag
push is not a dry run and runs release and container publication in the
protected GitHub `release` environment. The native publisher targets the
canonical repository explicitly, creates or reuses a validated draft release
handle before any asset mutation, and lets exactly six assets exist on the
release: `ralphie-darwin-arm64`, `ralphie-darwin-x64`, `ralphie-linux-arm64`,
`ralphie-linux-x64`, `SHA256SUMS`, and `SHA256SUMS.sigstore.json`. The
per-target `.sha256` sidecars, `release-metadata.json`, the four SPDX
documents, and `attestation-subjects.json` remain generated and pinned in the
staging bundle as in-checkout and attestation evidence but are never uploaded
as release assets. Any asset outside the six is an explicit conflict: the
publisher fails with a diagnostic naming the extra asset and never deletes,
overwrites, or ignores it. Before touching the remote release, the publisher
recomputes the checksum contract from the exact staged bytes and requires
`SHA256SUMS` to be exactly four entries in deterministic order
(`ralphie-darwin-arm64`, `ralphie-darwin-x64`, `ralphie-linux-arm64`,
`ralphie-linux-x64`), each line `<64-lowercase-hex>  <filename>` (two spaces),
with no sidecar, signature, or note lines; the `SHA256SUMS.sigstore.json`
bundle must keep its canonical shape and its message digest must bind exactly
the manifest bytes. Existing release assets are validated through the anonymous
URL template
`https://github.com/beremaran/ralphie/releases/download/<tag>/<asset-name>`
and accepted only when their SHA-256 matches the locally generated bytes. On a
draft handle, a missing asset is repaired by uploading it to that validated
handle only; a differing asset fails closed and is never replaced. Immediately
before the finalizing `draft: false` update, the publisher re-reads the exact
release by ID and asserts its id, upload URL, tag, `target_commitish` (the
validated `source_ref`), and that it is still a draft; any error before that
request leaves the release unpublished, and that update is the final
release-state change. An already-published handle is reconciled read-only: the
publisher re-reads it by ID, verifies the same tag/target, that the release
notes are non-empty and byte-identical to the notes GitHub generates for the
tag, the checksum contents, and all six asset digests, and returns success only
when everything matches. On a published handle, a missing, extra, or mismatched
asset or note is an explicit conflict: the publisher never uploads, deletes,
unpublishes, or creates another release.
Repository administrators must configure that environment in **Settings →
Environments → release** with the required reviewer(s); approval is required
before the final publisher can write release assets or packages.

### Container build input boundary

The `stage-container` job uses the repository root as its Docker context, but
`.dockerignore` is a deny-by-default allowlist for the package metadata, entry
point, build script, and runtime source only. The `Dockerfile` also copies those
inputs explicitly rather than using a broad `COPY . .`. Environment files,
local configuration and credentials, generated output, logs, tests, and
repository metadata are excluded.

No private build input is required. The container build receives only the
validated public version and commit values as `RALPHIE_VERSION` and
`RALPHIE_COMMIT_SHA`; GitHub tokens, OIDC tokens, and Pi/model credentials are
never build arguments, environment variables, labels, copied files, or build
metadata inputs. Credentials are supplied only at runtime where needed. The
version and commit remain the intentional public OCI labels.

### Verified create-only manifest promotion

Container promotion is exact and create-only. The reconciliation primitive in
`src/release/registry-reconcile.ts` (HTTP client in `registry-http-client.ts`,
fake registry in `registry-fixture.ts`) inspects every destination tag first
and reuses it only when its complete serialized digest equals the intended
digest; a missing tag is created through the OCI Distribution API with a
server-enforced compare-and-swap (`If-None-Match: *`), and the tag is reread
after the write. Any other digest, malformed response, or unexpected registry
status is a conflict/failure, and an unconditional tag write is never used.

The `push-container` publisher promotes the two staged OCI archives to their
per-platform `ghcr.io/beremaran/ralphie:<version>-amd64|arm64` tags and then
re-inspects each promoted image in GHCR: the registry digest must be a
lowercase `sha256:<64 hex>` value equal to the candidate's recorded `.digest`,
the platform must match, and the validated `version`/`source_ref` (and
license) OCI labels must match the release-gate outputs. The post-promotion
results are persisted as a `ralphie.publication-subjects.v1` map (immutable
artifact `ralphie-publication-subjects-<version>`) containing exactly the
`linux/amd64` and `linux/arm64` subjects; missing, duplicate, unsupported, or
mismatched subjects fail closed. Platform promotion is a separate step from
alias creation so attestation steps can later run in between, and every
version/minor/`latest`/`sha-<revision>` manifest alias is created from the
immutable `ghcr.io/beremaran/ralphie@sha256:<digest>` references rather than
from the `${VERSION}-amd64`/`${VERSION}-arm64` tags; a digest mismatch stops
the job before any alias is pushed.

Before any production tag write, `probeCreateOnlyPublishing` authenticates and
proves the target registry is create-only: for each writable media type (OCI
image manifest, Docker schema-2 manifest, OCI image index, Docker manifest
list) it seeds referenced blobs and child manifests, creates a disposable,
uniquely named probe tag, requires a competing second manifest to be rejected
(412 or 409) with the original digest unchanged, and fails closed if the
registry ignores `If-None-Match`, lacks a supported compare-and-swap
operation, or accepts the competing write. A create race is accepted only
after rereading the tag and finding the exact intended digest; authentication,
blob upload, and manifest-push failures propagate.

The dedicated `publish-npm` job is also limited to a validated `v*` tag and a
non-dry-run release. It rechecks that removing the leading `v` from the tag
produces the exact `package.json` version, then installs dependencies and runs
`bun run package:check` before `npm publish --provenance --access public`.
Publishing uses npm trusted publishing through the job's GitHub OIDC
permission; no long-lived npm credential is configured or required. Afterward,
the job runs the registry form of the package smoke check for the exact scoped
package/version and fails on any metadata or executable-version mismatch. It
retries only while that exact npm version is unavailable during registry
propagation.

Before the first npm release, configure the package's npmjs.com **Trusted
Publishers** setting with GitHub Actions owner `beremaran`, repository
`ralphie`, workflow filename `release.yml`, and environment `release`. The
workflow comments and this paragraph intentionally make that one-time binding
explicit; changing the workflow filename or environment requires updating the
npm publisher configuration too.

Before staging a release, run the local package smoke check from the checkout:

To create the same disposable package/installer staging inputs locally, provide
an exact validated checkout revision:

```bash
bun run package:stage -- \
  --version <release-version> \
  --commit-sha <40-character-commit-sha> \
  --output-dir release-package
```

The command refuses a version or source revision mismatch, extra staging files,
missing installer, unexpected npm tarball files, and missing embedded metadata.
It only runs the local build and `npm pack --ignore-scripts`; it never publishes.

```bash
bun run package:check
```

It creates and inspects a real tarball, installs it with production dependencies
in a fresh temporary project, and runs the installed executable with Bun. To
inspect only the `npm pack --dry-run` file list, use
`bun run package:inspect`. Registry verification is deliberately opt-in and
uses an isolated npm cache and working directory:

```bash
bun run package:check -- \
  --registry --package-spec @beremaran/ralphie@<release-version>
```

The check does not publish anything. Run the registry form only after the
release version is available from npm.

Each release also contains `SHA256SUMS.sigstore.json`, a canonical Sigstore
bundle for the exact bytes of `SHA256SUMS`. The release publisher uses keyless
Sigstore signing with the GitHub Actions OIDC issuer; no signing key or OIDC
token is stored in the repository, build context, logs, or release metadata.

## Verified Homebrew release handoff

The verified public release for the tap handoff is **0.1.2** (`v0.1.2`). The
release contains exactly the four native assets below, `SHA256SUMS`, and
`SHA256SUMS.sigstore.json`; no other release assets are part of this handoff.
Every digest is copied from that release's verified `SHA256SUMS`:

| Asset | SHA-256 |
| --- | --- |
| `ralphie-darwin-arm64` | `30be72de92306adb5609a6e8bc2ddb9e9cc29d671e8e0dd87c1921f11aaaf5c5` |
| `ralphie-darwin-x64` | `c08317b2f19011970d7a1579422d9c634cb756eaefafb147704ef8bbf1605ac8` |
| `ralphie-linux-arm64` | `c23f670a69c60c8770bb4958e91ae3007804bab889b55ee8807f2fffd04295f5` |
| `ralphie-linux-x64` | `c0d8b5ff1b24e554121bf879fb68380038ca7fbe27a63fd5857d6a1b27d2b300` |

The exact release is [v0.1.2](https://github.com/beremaran/ralphie/releases/tag/v0.1.2).
Native release asset URLs use the public template
`https://github.com/beremaran/ralphie/releases/download/<tag>/<asset-name>`;
clients must not use authenticated GitHub API asset URLs.
Its protected annotated tag resolves to commit
`a7c098f20ef212c6f6940825143396680c054bba`, and the active `Protect release
tags` ruleset covers `refs/tags/v*` with deletion and non-fast-forward updates
blocked. The signed manifest's certificate was verified with these exact
selectors:

- workflow identity:
  `https://github.com/beremaran/ralphie/.github/workflows/release.yml@refs/tags/v0.1.2`;
- repository: `beremaran/ralphie` and workflow name: `Release`;
- event/ref: `push`, `refs/tags/v0.1.2`;
- commit: `a7c098f20ef212c6f6940825143396680c054bba`; and
- OIDC issuer: `https://token.actions.githubusercontent.com`.

The release has exactly these six public assets:

- [ralphie-darwin-arm64](https://github.com/beremaran/ralphie/releases/download/v0.1.2/ralphie-darwin-arm64)
- [ralphie-darwin-x64](https://github.com/beremaran/ralphie/releases/download/v0.1.2/ralphie-darwin-x64)
- [ralphie-linux-arm64](https://github.com/beremaran/ralphie/releases/download/v0.1.2/ralphie-linux-arm64)
- [ralphie-linux-x64](https://github.com/beremaran/ralphie/releases/download/v0.1.2/ralphie-linux-x64)
- [SHA256SUMS](https://github.com/beremaran/ralphie/releases/download/v0.1.2/SHA256SUMS)
- [SHA256SUMS.sigstore.json](https://github.com/beremaran/ralphie/releases/download/v0.1.2/SHA256SUMS.sigstore.json)

The Sigstore bundle verification returned `verified: true`, and
`sha256sum --check SHA256SUMS` returned `OK` for all four assets. Downstream
tap automation must fail closed and rerun the exact-tag verification if any
asset, selector, signature, issuer, tag/commit binding, or checksum differs;
these recorded values must never be replaced with placeholders.

## Homebrew formula updates

`Formula/ralphie.rb` contains one `sha256` value for each release asset:
`darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64`. The deterministic
generator consumes an explicit `release-metadata.json` file from the validated
release bundle; it never queries GitHub or chooses a latest release. Its input
contract is an object with `version`, the exact `tag` (`v${version}`), and an
`assets` array containing exactly these four objects:

```json
{
  "version": "0.1.2",
  "tag": "v0.1.2",
  "assets": [
    { "name": "ralphie-darwin-arm64", "sha256": "<64 lowercase hex characters>" },
    { "name": "ralphie-darwin-x64", "sha256": "<64 lowercase hex characters>" },
    { "name": "ralphie-linux-arm64", "sha256": "<64 lowercase hex characters>" },
    { "name": "ralphie-linux-x64", "sha256": "<64 lowercase hex characters>" }
  ]
}
```

The version must be strict `major.minor.patch` with no prerelease suffix, and
the tag must match it exactly. Missing, duplicate, unexpected, or malformed
assets are rejected. Before changing a formula, verify the already-published
release directly with the exact-tag asset gate:

```bash
bun run verify:homebrew-assets -- \
  --tag v0.1.2 \
  --version 0.1.2 \
  --repository beremaran/ralphie \
  --output release-bundle/homebrew-assets.json
```

The verifier queries only `/releases/tags/<tag>`, rejects draft and prerelease
releases, downloads each of the four canonical binaries and its `.sha256`
sidecar, and writes `ralphie.homebrew-asset-manifest.v1` only after every byte
has been checked. It never selects `latest` or a branch. In GitHub Actions,
`GITHUB_REPOSITORY`, `GITHUB_API_URL`, and `GH_TOKEN`/`GITHUB_TOKEN` are used
when provided. The resulting entries are sorted by asset name and include the
target, exact asset name, release download URL, and verified SHA-256.

The workflow integration can generate the formula in place from the bundle with:

```bash
bun run generate:homebrew-formula -- \
  --metadata release-bundle/release-metadata.json \
  --formula Formula/ralphie.rb
```

Only the region between the `BEGIN RALPHIE GENERATED RELEASE METADATA` and
`END RALPHIE GENERATED RELEASE METADATA` markers is replaced. The generator
fails when the markers are missing, duplicated, or out of order, preserving the
description, homepage, install behavior, and smoke test outside that region.

The deterministic preparation step guards the formula change before anything
is applied to the tap branch. It consumes the exact-tag verifier's manifest
(`ralphie.homebrew-asset-manifest.v1`) plus the validated tag and version,
feeds that manifest to the generator in a temporary output, requires a fresh
target-branch checkout to be clean, and then applies the update only when it
satisfies the change guard:

```bash
bun run prepare:homebrew-formula -- \
  --manifest release-bundle/homebrew-assets.json \
  --tag v0.1.2 \
  --version 0.1.2 \
  --formula Formula/ralphie.rb \
  --checkout .
```

The guard requires exactly one ordered BEGIN/END marker pair and byte-for-byte
identity between the original and candidate formula outside the generated
region. It rejects a changed path other than `Formula/ralphie.rb`, any pending
edit outside the marked region, malformed or unmarked formula content, a
tag/version mismatch, and any manifest that is not exactly
`ralphie.homebrew-asset-manifest.v1`; it never uses `git reset`, `git clean`, a
destructive checkout, or a force operation. The step reports an explicit
`homebrew_formula_result=changed` or `unchanged` outcome (also returned as a
`changed`/`unchanged` result) so callers can skip a commit when the desired
metadata is already present. Validate the generated formula against the same
release manifest before submitting the formula change:

```bash
bun run validate:homebrew-formula -- \
  --formula Formula/ralphie.rb \
  --manifest release-bundle/SHA256SUMS \
  --version 0.1.2
```

The validator also rejects wrong asset names or release versions, malformed
hashes, and values that differ from the canonical manifest. Never copy one
platform's checksum to another branch or use a placeholder.

### One guarded branch and pull request per release

The mutation layer around the guarded formula candidate is the deterministic
seam `scripts/reconcile-homebrew-update.ts` (run as `reconcile:homebrew-update`,
with `--owner --repo --version --tag --manifest --checkout`). It starts from a
fresh clone of the tap, runs an ordinary `git fetch origin`, re-derives the
guarded candidate from the fetched `main` formula through the exact generator,
and reconciles exactly one branch and one pull request on the fixed `main`
base:

- the branch is the deterministic `automation/homebrew-v<version>`;
- the pull-request title is the deterministic
  `Update Homebrew formula for v<version>`;
- the pull-request body records the exact tag/version and the verified
  manifest checksums with no timestamps and no download reference other than
  the exact `v<tag>` release URLs; and
- the commit is created with plain plumbing (`hash-object`, `mktree`,
  `commit-tree`) so the working tree is never touched, reset, cleaned, or
  force-checked-out.

The candidate is accepted only when `Formula/ralphie.rb` is the sole changed
path and every change lies inside the generated marker region. An existing
branch is reused only when it is based on the current `main`; otherwise the
step fails closed as an unexpected base. A retry updates the branch only when
the guarded generated content differs and then only through an ordinary
non-force fast-forward push preceded by an exact remote-head read; a push that
turns out to be a non-fast-forward (a concurrent head change) fails instead of
overwriting anything, and the branch is never reset, force-pushed, deleted, or
recreated. Zero matching open pull requests permits creation only when the
formula actually changes, one matching open pull request is reused, and
multiple matching pull requests fail instead of creating a duplicate. A
`main` that already contains the desired verified metadata resolves to
`main-current` with zero branch or pull-request mutations. Fetch, push, and
pull-request conflicts never happen after a mutation; every failure leaves the
remote untouched. The seam takes GitHub mutations through the injected
`HomebrewUpdateApi` (deterministic in-memory fake in tests, GitHub REST
adapter over fetch in `createHomebrewUpdateApi`) and never puts them in
formula-generation code.

```bash
bun run reconcile:homebrew-update -- \
  --owner beremaran \
  --repo ralphie \
  --version 0.1.2 \
  --tag v0.1.2 \
  --manifest release-bundle/homebrew-assets.json \
  --checkout .
```

## Release checksum trust policy

Downstream consumers must accept a checksum manifest only when its bundle
verifies against all of these constraints:

- issuer: `https://token.actions.githubusercontent.com`;
- repository: `beremaran/ralphie`;
- workflow identity:
  `https://github.com/beremaran/ralphie/.github/workflows/release.yml@refs/tags/<tag>`;
- GitHub workflow event: `push` for the exact `refs/tags/<tag>` (or
  `workflow_dispatch` only when the manual run is started from that same
  protected tag); and
- workflow commit: the exact commit targeted by that protected tag.

After downloading both `SHA256SUMS` and `SHA256SUMS.sigstore.json` from the same
release, verify the signature before using the checksums (`--trigger
workflow_dispatch` is used instead for a manually published release):

```bash
TAG=v0.1.0
SOURCE_REF=<40-character commit SHA targeted by $TAG>
sigstore verify github SHA256SUMS \
  --bundle SHA256SUMS.sigstore.json \
  --repository beremaran/ralphie \
  --name Release \
  --cert-identity "https://github.com/beremaran/ralphie/.github/workflows/release.yml@refs/tags/$TAG" \
  --trigger push \
  --sha "$SOURCE_REF" \
  --ref "refs/tags/$TAG"
sha256sum --check SHA256SUMS
```

Reject the release if any identity, issuer, event, tag/ref, commit, bundle, or
checksum validation differs. `sigstore verify github` uses GitHub's
`https://token.actions.githubusercontent.com` issuer; a generic Sigstore
verifier must be given that issuer explicitly. The release workflow performs
the same identity and issuer check before publication; its validated
protected-tag context binds the signing run to `source_ref`.

See [Getting started](getting-started.md) for the installer and [Development](development.md)
for the local release gate. The root [README](../README.md) retains a compact
verification command for discoverability, but this page owns the policy.
For a no-credentials check of the published repository and every distribution
channel, run the [public distribution verification](public-distribution.md#unauthenticated-verification)
command after the release is available.
