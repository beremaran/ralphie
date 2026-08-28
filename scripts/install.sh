#!/usr/bin/env sh
# Install the standalone Ralphie binary.
#
# Usage:
#   sh scripts/install.sh            # installs to $HOME/.local/bin
#   sh scripts/install.sh /usr/local/bin
#   RALPHIE_VERSION=latest sh scripts/install.sh
#
# The release asset name is derived from the current platform:
#   ralphie-<os>-<arch>  (e.g. ralphie-darwin-arm64)
set -eu

TEMP_FILE=
cleanup_status=0

trap '
  cleanup_status=$?
  if [ -n "$TEMP_FILE" ]; then
    rm -f "$TEMP_FILE" || :
  fi
  exit "$cleanup_status"
' 0
trap 'exit 1' 1 2 3 15

is_valid_release_tag() {
  candidate=$1
  case "$candidate" in
    v*) release_version=${candidate#v} ;;
    *) return 1 ;;
  esac

  # Keep this grammar in sync with the release workflow: numeric components
  # have no leading zeroes and prerelease/build suffixes are not accepted.
  case "$release_version" in
    ''|*[!0-9.]*) return 1 ;;
  esac

  saved_ifs=${IFS- }
  IFS=.
  # The unquoted expansion intentionally splits the three dot-separated components.
  # shellcheck disable=SC2086
  set -- $release_version
  IFS=$saved_ifs
  [ "$#" -eq 3 ] || return 1

  for component do
    case "$component" in
      0|[1-9]*) ;;
      *) return 1 ;;
    esac
    case "$component" in
      *[!0-9]*) return 1 ;;
    esac
  done
}

# --- destination -----------------------------------------------------------
if [ "$#" -gt 1 ]; then
  echo "ralphie: expected at most one destination directory" >&2
  exit 1
fi

if [ "$#" -eq 1 ]; then
  DEST=$1
else
  if [ -z "${HOME:-}" ]; then
    echo "ralphie: HOME must be set when no destination is supplied" >&2
    exit 1
  fi
  DEST="$HOME/.local/bin"
fi

if [ -z "$DEST" ]; then
  echo "ralphie: destination directory must not be empty" >&2
  exit 1
fi
if ! mkdir -p "$DEST"; then
  echo "ralphie: could not create destination directory '$DEST'" >&2
  exit 1
fi
if [ ! -d "$DEST" ] || [ ! -w "$DEST" ]; then
  echo "ralphie: destination directory '$DEST' is not a writable directory" >&2
  exit 1
fi

TARGET="$DEST/ralphie"
if [ -d "$TARGET" ]; then
  echo "ralphie: target '$TARGET' is a directory" >&2
  exit 1
fi

# --- resolve version -------------------------------------------------------
# Use '-' rather than ':-': an explicitly empty value is malformed input,
# while only an unset variable means latest.
RALPHIE_VERSION="${RALPHIE_VERSION-latest}"
if [ "$RALPHIE_VERSION" = latest ]; then
  # Resolve the latest release tag from the GitHub API without authentication.
  API_RESPONSE="$(
    curl -fsSL -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/beremaran/ralphie/releases/latest"
  )" || {
    echo "ralphie: could not resolve latest release (check network)" >&2
    exit 1
  }
  RELEASE_TAG="$(
    printf '%s\n' "$API_RESPONSE" |
      sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
  )"
  if ! is_valid_release_tag "$RELEASE_TAG"; then
    echo "ralphie: latest release returned invalid tag '$RELEASE_TAG'" >&2
    exit 1
  fi
else
  case "$RALPHIE_VERSION" in
    v*) RELEASE_TAG=$RALPHIE_VERSION ;;
    *) RELEASE_TAG=v$RALPHIE_VERSION ;;
  esac
  if ! is_valid_release_tag "$RELEASE_TAG"; then
    echo "ralphie: invalid release version '$RALPHIE_VERSION'" >&2
    exit 1
  fi
fi

# --- detect platform -------------------------------------------------------
if ! RAW_OS="$(uname -s)"; then
  echo "ralphie: could not detect operating system" >&2
  exit 1
fi
if ! RAW_ARCH="$(uname -m)"; then
  echo "ralphie: could not detect architecture" >&2
  exit 1
fi

case "$RAW_OS" in
  Linux|linux) OS=linux ;;
  Darwin|darwin|Mac|mac) OS=darwin ;;
  *)
    echo "ralphie: unsupported operating system '$RAW_OS'" >&2
    exit 1
    ;;
esac

case "$RAW_ARCH" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *)
    echo "ralphie: unsupported architecture '$RAW_ARCH'" >&2
    exit 1
    ;;
esac

ASSET="ralphie-${OS}-${ARCH}"
EXPECTED_VERSION=${RELEASE_TAG#v}
RELEASE_URL="https://github.com/beremaran/ralphie/releases/download/$RELEASE_TAG/$ASSET"

if ! TEMP_FILE="$(mktemp "$DEST/.ralphie.XXXXXX")"; then
  echo "ralphie: could not create a temporary file in '$DEST'" >&2
  exit 1
fi
if [ -z "$TEMP_FILE" ]; then
  echo "ralphie: temporary file creation returned an empty path" >&2
  exit 1
fi

echo "ralphie: downloading $ASSET ($RELEASE_TAG) -> $TARGET"
if ! curl -fsSL --retry 3 -o "$TEMP_FILE" "$RELEASE_URL"; then
  echo "ralphie: download failed for $RELEASE_URL" >&2
  exit 1
fi

if ! chmod +x "$TEMP_FILE"; then
  echo "ralphie: could not make the downloaded binary executable" >&2
  exit 1
fi

if ! REPORTED_VERSION="$("$TEMP_FILE" --version)"; then
  echo "ralphie: downloaded binary could not be executed" >&2
  exit 1
fi
if [ "$REPORTED_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "ralphie: downloaded binary reports version '$REPORTED_VERSION', expected '$EXPECTED_VERSION'" >&2
  exit 1
fi

if ! mv "$TEMP_FILE" "$TARGET"; then
  echo "ralphie: could not replace '$TARGET'" >&2
  exit 1
fi
TEMP_FILE=

echo "ralphie: installed to $TARGET"
printf "ralphie: verify with '%s' --version (ensure %s is on PATH).\n" \
  "$TARGET" "$DEST"
exit 0
