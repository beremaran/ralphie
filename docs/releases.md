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

The repository must enforce that binding with an active tag ruleset covering
`v*`. Configure **Settings → Rules → Rulesets** to target tags matching `v*`,
restrict both tag updates and deletions, and configure no bypass actors. The
workflow requires the triggering ref to report as protected before it builds;
this protection, rather than a non-atomic API recheck, closes the check/use
race between validation and publication.

Manual dispatches default to `dry_run: true`. Every validated release run
builds and smoke-tests `linux/amd64` and `linux/arm64` container candidates
without logging into GHCR or pushing public tags. Each platform is staged as
an immutable `actions/upload-artifact@v4` artifact named
`ralphie-container-candidate-<version>-<arch>`. Native targets are likewise
staged as `ralphie-<version>-<target>` artifacts containing the renamed
executable and its `<executable>.sha256` checksum. After all four native legs
succeed, the aggregation job downloads those exact versioned artifacts, rejects
missing, extra, duplicate, and cross-version files, and recomputes each binary
checksum against its sidecar. It stages the immutable
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
must verify those fields before promotion. The canonical GHCR tag is the
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
handle before any asset mutation, and publishes its assets only after all
staging and signing steps succeed. Retries repair same-named assets through the
handle; an already-published handle is terminal and is never recreated.
Repository administrators must configure that environment in **Settings →
Environments → release** with the required reviewer(s); approval is required
before the final publisher can write release assets or packages.

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
Validate the generated formula against the same release manifest before
submitting the formula change:

```bash
bun run validate:homebrew-formula -- \
  --formula Formula/ralphie.rb \
  --manifest release-bundle/SHA256SUMS \
  --version 0.1.2
```

The validator also rejects wrong asset names or release versions, malformed
hashes, and values that differ from the canonical manifest. Never copy one
platform's checksum to another branch or use a placeholder.

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
