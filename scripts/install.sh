#!/usr/bin/env sh
# Install the standalone Ralphie binary.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/beremaran/ralphie/main/scripts/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/beremaran/ralphie/main/scripts/install.sh -o install-ralphie.sh
#   sh install-ralphie.sh
#   curl -fsSL https://raw.githubusercontent.com/beremaran/ralphie/main/scripts/install.sh | sh -s -- /usr/local/bin
#   curl -fsSL https://raw.githubusercontent.com/beremaran/ralphie/main/scripts/install.sh | RALPHIE_VERSION=0.1.0 sh
#   curl -fsSL https://raw.githubusercontent.com/beremaran/ralphie/main/scripts/install.sh | RALPHIE_VERSION=v0.1.0 sh
#
# With no destination argument, installs exactly to $HOME/.local/bin. One
# optional positional argument selects the destination directory; it must be
# writable. For the default destination, add it to PATH persistently and load
# the change before running `ralphie --version`:
#   echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.profile"
#   . "$HOME/.profile"
#   ralphie --version
#
# The release asset name is derived from the current platform:
#   ralphie-<os>-<arch>  (e.g. ralphie-darwin-arm64)
set -eu

TEMP_FILE=
CHECKSUMS_FILE=
BUNDLE_FILE=
cleanup_status=0

trap '
  cleanup_status=$?
  if [ -n "$TEMP_FILE" ]; then
    rm -f "$TEMP_FILE" || :
  fi
  if [ -n "$CHECKSUMS_FILE" ]; then
    rm -f "$CHECKSUMS_FILE" || :
  fi
  if [ -n "$BUNDLE_FILE" ]; then
    rm -f "$BUNDLE_FILE" || :
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

is_valid_sha256() {
  candidate=$1
  case "$candidate" in
    ''|*[!0-9a-f]*) return 1 ;;
  esac
  [ "${#candidate}" -eq 64 ]
}

is_valid_commit_sha() {
  candidate=$1
  case "$candidate" in
    ''|*[!0-9a-f]*) return 1 ;;
  esac
  [ "${#candidate}" -eq 40 ]
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

  # grep -o emits every matching field on its own line. Keeping all matches
  # means a response containing more than one tag cannot silently select one.
  TAG_MATCHES="$(
    printf '%s\n' "$API_RESPONSE" |
      grep -Eo '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' || :
  )"
  RELEASE_TAG="$(
    printf '%s\n' "$TAG_MATCHES" |
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
RELEASE_BASE="https://github.com/beremaran/ralphie/releases/download/$RELEASE_TAG"
RELEASE_URL="$RELEASE_BASE/$ASSET"
CHECKSUMS_URL="$RELEASE_BASE/SHA256SUMS"
BUNDLE_URL="$RELEASE_BASE/SHA256SUMS.sigstore.json"
COMMIT_URL="https://api.github.com/repos/beremaran/ralphie/commits/$RELEASE_TAG"
CERT_IDENTITY="https://github.com/beremaran/ralphie/.github/workflows/release.yml@refs/tags/$RELEASE_TAG"

# Verification is mandatory. In particular, never fall back to an unsigned
# checksum, a different hash utility, or an unverified downloaded binary.
if ! command -v sigstore >/dev/null 2>&1; then
  echo "ralphie: sigstore verifier is required but was not found on PATH" >&2
  exit 1
fi
if ! command -v sha256sum >/dev/null 2>&1 &&
  ! command -v shasum >/dev/null 2>&1; then
  echo "ralphie: no SHA-256 verifier (sha256sum or shasum) was found on PATH" >&2
  exit 1
fi

# Resolve the commit targeted by the same tag. The Sigstore trust policy binds
# the GitHub Actions certificate to this commit as well as to the tag.
COMMIT_RESPONSE="$(
  curl -fsSL -H "Accept: application/vnd.github+json" "$COMMIT_URL"
)" || {
  echo "ralphie: could not resolve release commit (check network)" >&2
  exit 1
}
SHA_MATCHES="$(
  printf '%s\n' "$COMMIT_RESPONSE" |
    grep -Eo '"sha"[[:space:]]*:[[:space:]]*"[0-9a-f]{40}"' || :
)"
SOURCE_REF="$(
  printf '%s\n' "$SHA_MATCHES" |
    sed -n '1s/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p'
)"
if ! is_valid_commit_sha "$SOURCE_REF"; then
  echo "ralphie: release commit response did not contain one valid commit SHA" >&2
  exit 1
fi

# These are independent temporary files in DEST, so the final rename remains
# on the destination filesystem and can atomically replace an existing target.
if ! TEMP_FILE="$(mktemp "$DEST/.ralphie.XXXXXX")" ||
  [ -z "$TEMP_FILE" ] || [ ! -f "$TEMP_FILE" ]; then
  echo "ralphie: could not create a temporary binary in '$DEST'" >&2
  exit 1
fi
if ! CHECKSUMS_FILE="$(mktemp "$DEST/.ralphie.XXXXXX")" ||
  [ -z "$CHECKSUMS_FILE" ] || [ ! -f "$CHECKSUMS_FILE" ]; then
  echo "ralphie: could not create a temporary checksum manifest in '$DEST'" >&2
  exit 1
fi
if ! BUNDLE_FILE="$(mktemp "$DEST/.ralphie.XXXXXX")" ||
  [ -z "$BUNDLE_FILE" ] || [ ! -f "$BUNDLE_FILE" ]; then
  echo "ralphie: could not create a temporary Sigstore bundle in '$DEST'" >&2
  exit 1
fi

if ! curl -fsSL --retry 3 -o "$TEMP_FILE" "$RELEASE_URL"; then
  echo "ralphie: download failed for $RELEASE_URL" >&2
  exit 1
fi
if [ ! -s "$TEMP_FILE" ]; then
  echo "ralphie: downloaded asset is empty" >&2
  exit 1
fi

if ! curl -fsSL --retry 3 -o "$CHECKSUMS_FILE" "$CHECKSUMS_URL"; then
  echo "ralphie: checksum manifest download failed for $CHECKSUMS_URL" >&2
  exit 1
fi
if [ ! -s "$CHECKSUMS_FILE" ]; then
  echo "ralphie: checksum manifest is missing or empty" >&2
  exit 1
fi

if ! curl -fsSL --retry 3 -o "$BUNDLE_FILE" "$BUNDLE_URL"; then
  echo "ralphie: Sigstore bundle download failed for $BUNDLE_URL" >&2
  exit 1
fi
if [ ! -s "$BUNDLE_FILE" ]; then
  echo "ralphie: Sigstore bundle is missing or empty" >&2
  exit 1
fi

# Verify the exact manifest before reading any checksum from it. These options
# are the repository, workflow, issuer, event, tag, and commit constraints from
# the release checksum trust policy. Both events are explicit policy choices;
# the identity, source tag, and source commit remain fixed in either case.
verify_manifest() {
  source_event=$1
  sigstore verify github "$CHECKSUMS_FILE" \
    --bundle "$BUNDLE_FILE" \
    --repository beremaran/ralphie \
    --workflow release.yml \
    --cert-identity "$CERT_IDENTITY" \
    --cert-oidc-issuer https://token.actions.githubusercontent.com \
    --source-event "$source_event" \
    --source-sha "$SOURCE_REF" \
    --source-tag "$RELEASE_TAG"
}

if ! verify_manifest push && ! verify_manifest workflow_dispatch; then
  echo "ralphie: Sigstore verification failed for $RELEASE_TAG" >&2
  exit 1
fi

# Do not use a generic --check operation: it could accept another platform's
# line or a duplicate. The manifest must contain one well-formed entry whose
# filename is exactly the selected asset.
if ! EXPECTED_SHA256="$(
  awk -v asset="$ASSET" '
    $2 == asset {
      entries++
      if (NF != 2 || length($1) != 64 || $1 ~ /[^0-9A-Fa-f]/) invalid=1
      digest=$1
    }
    END {
      if (entries != 1 || invalid) exit 1
      print digest
    }
  ' "$CHECKSUMS_FILE"
)"; then
  echo "ralphie: checksum manifest has no single valid entry for $ASSET" >&2
  exit 1
fi
if ! is_valid_sha256 "$EXPECTED_SHA256"; then
  echo "ralphie: checksum manifest has an invalid digest for $ASSET" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  if ! HASH_OUTPUT="$(sha256sum "$TEMP_FILE")"; then
    echo "ralphie: could not calculate the asset SHA-256" >&2
    exit 1
  fi
else
  if ! HASH_OUTPUT="$(shasum -a 256 "$TEMP_FILE")"; then
    echo "ralphie: could not calculate the asset SHA-256" >&2
    exit 1
  fi
fi
ACTUAL_SHA256=${HASH_OUTPUT%%[[:space:]]*}
if ! is_valid_sha256 "$ACTUAL_SHA256" ||
  [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  echo "ralphie: checksum mismatch for $ASSET" >&2
  exit 1
fi

if ! chmod +x "$TEMP_FILE"; then
  echo "ralphie: could not make the verified binary executable" >&2
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
