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
# The release asset name is resolved from the checked-in generated target
# mapping (targets/posix-installer-targets.json): the raw `uname`
# OS/architecture values are normalized through the mapping's alias tables,
# the canonical target record is selected, and exactly that record's
# `releaseAssetName` is downloaded (e.g. ralphie-darwin-arm64). The asset
# name is never reconstructed from the platform pair.
set -eu

TEMP_FILE=
CHECKSUMS_FILE=
BUNDLE_FILE=
MAPPING_FILE=
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
  if [ -n "$MAPPING_FILE" ]; then
    rm -f "$MAPPING_FILE" || :
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
# The checked-in POSIX installer mapping (targets/posix-installer-targets.json)
# is generated from the canonical target catalog; it carries the accepted
# `uname` OS/architecture aliases and the full target records. The download
# asset name is read from the matching record's `releaseAssetName` and is
# never reconstructed; a raw pair that matches no alias or no record fails
# clearly below.
MAPPING_URL="https://raw.githubusercontent.com/beremaran/ralphie/main/targets/posix-installer-targets.json"

if ! RAW_OS="$(uname -s)"; then
  echo "ralphie: could not detect operating system" >&2
  exit 1
fi
if ! RAW_ARCH="$(uname -m)"; then
  echo "ralphie: could not detect architecture" >&2
  exit 1
fi

if ! MAPPING_FILE="$(mktemp "$DEST/.ralphie.XXXXXX")" ||
  [ -z "$MAPPING_FILE" ] || [ ! -f "$MAPPING_FILE" ]; then
  echo "ralphie: could not create a temporary target mapping in '$DEST'" >&2
  exit 1
fi
if ! curl -fsSL --retry 3 -o "$MAPPING_FILE" "$MAPPING_URL"; then
  echo "ralphie: could not fetch the release target mapping (check network)" >&2
  exit 1
fi
if [ ! -s "$MAPPING_FILE" ]; then
  echo "ralphie: release target mapping is missing or empty" >&2
  exit 1
fi

# Map one raw `uname` value through the generated alias table: case-fold it,
# then read the canonical os/arch value from the matching alias entry. The
# keys and values are known-shape JSON produced by the deterministic
# serializer, so no JSON parser is needed at install time.
resolve_alias() {
  section=$1
  raw_value=$2
  normalized=$(printf '%s' "$raw_value" | tr '[:upper:]' '[:lower:]')
  awk -v section="$section" -v key="$normalized" '
    /^  "archAliases": {/ { current = "arch"; next }
    /^  "osAliases": {/ { current = "os"; next }
    /^  "targets": \[/ { exit }
    /^    "/ && current == section {
      split($0, fields, "\"")
      if (fields[2] == key && fields[4] != "") print fields[4]
    }
  ' "$MAPPING_FILE"
}

# Select the record whose canonical os/arch pair matches and print exactly its
# releaseAssetName field. Records are sorted by id; the pair is guaranteed to
# appear at most once by catalog validation.
resolve_record_asset() {
  want_os=$1
  want_arch=$2
  awk -v want_os="$want_os" -v want_arch="$want_arch" '
    /^    {/ { in_record = 1; rec_os = ""; rec_arch = ""; rec_asset = ""; next }
    in_record && /^      "/ {
      split($0, fields, "\"")
      if (fields[2] == "os") rec_os = fields[4]
      else if (fields[2] == "arch") rec_arch = fields[4]
      else if (fields[2] == "releaseAssetName") rec_asset = fields[4]
    }
    in_record && /^    },?$/ {
      if (rec_os == want_os && rec_arch == want_arch) {
        print rec_asset
        exit
      }
      in_record = 0
    }
  ' "$MAPPING_FILE"
}

OS="$(resolve_alias os "$RAW_OS")"
if [ -z "$OS" ]; then
  echo "ralphie: unsupported operating system '$RAW_OS'" >&2
  exit 1
fi
ARCH="$(resolve_alias arch "$RAW_ARCH")"
if [ -z "$ARCH" ]; then
  echo "ralphie: unsupported architecture '$RAW_ARCH'" >&2
  exit 1
fi
ASSET="$(resolve_record_asset "$OS" "$ARCH")"
if [ -z "$ASSET" ]; then
  echo "ralphie: no release asset matches platform '$RAW_OS'/'$RAW_ARCH'" >&2
  exit 1
fi
rm -f "$MAPPING_FILE"
MAPPING_FILE=

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
    --name Release \
    --cert-identity "$CERT_IDENTITY" \
    --trigger "$source_event" \
    --sha "$SOURCE_REF" \
    --ref "refs/tags/$RELEASE_TAG"
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
