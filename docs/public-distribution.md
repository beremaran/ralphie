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

Publishing jobs use the protected `release` environment, with the `beremaran`
maintainer configured as its required reviewer. The active `Protect release
tags` repository ruleset covers `refs/tags/v*`, blocks deletion and
non-fast-forward updates, has no bypass actors, and supplies the protected-tag
binding required by the release workflow.

Public topology does not by itself assert that every channel already contains a
published artifact. The native release workflow owns the four platform assets
and their public release records; installer, Homebrew, and OCI distribution
work is tracked by #73.

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

## Privacy boundary

No Ralphie source or distribution component is intentionally private. In
particular, users do not need repository credentials to read the source,
installer, formula, release page, or published artifacts.

User-owned data remains outside this public distribution topology: GitHub and
Pi credentials, local Ralphie run state and workspaces, and any private target
repositories operated on by Ralphie are not published by this repository.
Access to a private target repository still requires that target's own GitHub
credentials; this does not make any Ralphie component private.
