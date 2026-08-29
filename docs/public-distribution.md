# Public distribution topology

This page records the maintainer-approved source and distribution topology for
Ralphie. It is the authority for repository identity and public endpoint
ownership; [Releases](releases.md) owns the release process and artifact trust
contract.

## Decision

On 2026-08-29, the maintainer approved making the source repository public.
`beremaran/ralphie` is the single canonical repository for both source and
distribution metadata:

- canonical slug: `beremaran/ralphie`;
- repository: <https://github.com/beremaran/ralphie>;
- Git clone URL: <https://github.com/beremaran/ralphie.git>;
- releases and native assets: <https://github.com/beremaran/ralphie/releases>;
- raw installer: <https://raw.githubusercontent.com/beremaran/ralphie/main/scripts/install.sh>;
- Homebrew custom tap: `brew tap beremaran/ralphie https://github.com/beremaran/ralphie`;
- Homebrew formula source: <https://raw.githubusercontent.com/beremaran/ralphie/main/Formula/ralphie.rb>;
- OCI image: `ghcr.io/beremaran/ralphie`; and
- npm package: <https://www.npmjs.com/package/@beremaran/ralphie>.

There is no separate source-to-distribution mapping and no second release host.
The public source repository owns the release workflow, release records,
installer, Homebrew formula, and OCI source label. Do not mirror or redirect an
individual channel to another repository without a new explicit topology
decision that updates this page and all canonical identities together.

## Repository publication setup

The repository is public and was verified readable without GitHub repository
credentials on 2026-08-29. GitHub Actions is enabled. The repository's default
workflow token permission remains read-only; publication jobs in
`.github/workflows/release.yml` request only their explicit `contents: write`,
`packages: write`, or `id-token: write` permissions.

The public repository metadata is part of the same canonical identity:

- description: `Turn a GitHub issue queue into reviewed commits with Pi.`;
- homepage: <https://github.com/beremaran/ralphie#readme>; and
- topics: `ai`, `automation`, `bun`, `cli`, `github`, `github-actions`,
  `github-issues`, `homebrew`, `oci`, and `pi`.

The unauthenticated distribution check verifies these fields through the public
GitHub API. Keep the list aligned with the repository settings when the product
or its supported channels change.

Publishing jobs use the protected `release` environment, with the `beremaran`
maintainer configured as its required reviewer. The active `Protect release
tags` repository ruleset covers `refs/tags/v*`, blocks deletion and
non-fast-forward updates, has no bypass actors, and supplies the protected-tag
binding required by the release workflow.

The native release workflow owns the four platform assets and their public
release records. The installer, Homebrew, and OCI channels were published and
verified as part of #73; this page records their stable ownership for future
releases.

## License boundary

The maintainer-approved project license is MIT. The canonical license text and
copyright notice are in the root [`LICENSE`](../LICENSE) file; `package.json`,
the Homebrew formula, and the OCI image use the matching `MIT` SPDX identifier.
There is no separate public distribution copy to synchronize because the
canonical repository directly supplies every distribution channel listed
above.

The MIT license covers Ralphie's project source and the distributions built
from it. Third-party dependencies remain under their respective licenses, and
Ralphie's license does not change the terms or visibility of user-owned data,
credentials, or target repositories.

## Unauthenticated verification

Run the public distribution check from a clean checkout with `GH_TOKEN` and
`GITHUB_TOKEN` unset:

```bash
env -u GH_TOKEN -u GITHUB_TOKEN bun run verify:public-distribution
```

The check reads this topology document and the local README, then uses only
anonymous HTTP requests to verify the repository metadata, latest stable
release, every release asset, checksum and Sigstore bundle, raw installer,
Homebrew formula and its four download URLs, GitHub license metadata, and the
current-release/`latest` OCI manifests and MIT labels. It installs the fetched
installer into a temporary directory and checks its version; the temporary
directory is removed on completion. The installer verification requires the
`sigstore` CLI and a SHA-256 utility on `PATH`.

The same command runs in
`.github/workflows/public-distribution.yml` on pushes to `main`, on a daily
schedule, and when manually dispatched. The workflow disables checkout
credential persistence and explicitly removes both GitHub token variables, so
it cannot accidentally pass using repository credentials. The release version
is discovered from the public `releases/latest` endpoint; no future release
URL or repository name needs to be guessed in the workflow.

## Privacy boundary

No Ralphie source or distribution component is intentionally private. In
particular, users do not need repository credentials to read the source,
installer, formula, release page, or published artifacts.

User-owned data remains outside this public distribution topology: GitHub and
Pi credentials, local Ralphie run state and workspaces, and any private target
repositories operated on by Ralphie are not published by this repository.
Access to a private target repository still requires that target's own GitHub
credentials; this does not make any Ralphie component private.
