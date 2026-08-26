#!/usr/bin/env sh
# Install the standalone Ralphie binary.
#
# Usage:
#   sh scripts/install.sh            # installs to ~/.local/bin (or ~/bin)
#   sh scripts/install.sh /usr/local/bin
#   RALPHIE_VERSION=latest sh scripts/install.sh
#
# The release asset name is derived from the current platform:
#   ralphie-<os>-<arch>  (e.g. ralphie-darwin-arm64)
set -eu

# --- resolve version -------------------------------------------------------
RALPHIE_VERSION="${RALPHIE_VERSION:-latest}"
if [ "$RALPHIE_VERSION" != "latest" ]; then
  ASSET_VERSION="$RALPHIE_VERSION"
else
  # Resolve the latest release tag from the GitHub API (no auth needed for
  # public repos, but set GITHUB_TOKEN to avoid low rate limits).
  ASSET_VERSION="$(
    curl -fsSL -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/beremaran/ralphie/releases/latest" \
      | grep -Eo '"tag_name":[[:space:]]*"[^"]+"' \
      | sed -E 's/.*"tag_name":[[:space:]]*"([^"]+)".*/\1/'
  )"
  if [ -z "$ASSET_VERSION" ]; then
    echo "ralphie: could not resolve latest release (check network / GITHUB_TOKEN)" >&2
    exit 1
  fi
fi

# --- detect platform -------------------------------------------------------
detect() {
  case "$1" in
    *linux*) echo linux ;;
    *darwin*|*mac*) echo darwin ;;
    *) echo "" ;;
  esac
}

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "ralphie: unsupported architecture '$ARCH'" >&2; exit 1 ;;
esac

OS="$(detect "$OS")"
if [ -z "$OS" ]; then
  echo "ralphie: unsupported operating system '$OS'" >&2
  exit 1
fi

ASSET="ralphie-${OS}-${ARCH}"
DEST="${1:-$(command -v bin 2>/dev/null || echo "$HOME/.local")/bin}"
mkdir -p "$DEST"
TARGET="$DEST/ralphie"

echo "ralphie: downloading $ASSET (v$ASSET_VERSION) -> $TARGET"

curl -fsSL --retry 3 -o "$TARGET" \
  "https://github.com/beremaran/ralphie/releases/download/v${ASSET_VERSION}/${ASSET}"

chmod +x "$TARGET"
echo "ralphie: installed to $TARGET"
echo "ralphie: run '$ralphie --version' to verify (ensure $DEST is on PATH)."
