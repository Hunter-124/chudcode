#!/bin/sh
set -eu

PRODUCT_NAME="Chudcode"
PRODUCT_VERSION="0.1.0"
UPSTREAM_VERSION="18.0.8"
CLI_NAME="chudcode"
LEGACY_BINARY_NAME="omp"
VERIFIED_TARGETS="${CHUDCODE_VERIFIED_TARGETS:-linux-x64}"
DIST_DIR="${CHUDCODE_DIST_DIR:-dist/chudcode-v${PRODUCT_VERSION}}"
EXPECTED_VERSION_OUTPUT="${PRODUCT_NAME} v${PRODUCT_VERSION} (based on ${LEGACY_BINARY_NAME} ${UPSTREAM_VERSION})"

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"

die() {
	printf '%s\n' "error: $*" >&2
	exit 1
}

usage() {
	cat <<EOF
Usage: scripts/release-v01/build.sh [--dry-run] [target]

Build and stage one ${PRODUCT_NAME} release artifact. The default and currently
verified target is linux-x64. Set CHUDCODE_VERIFIED_TARGETS only after a target
has started successfully on its matching OS, architecture, and libc.
EOF
}

dry_run=0
target="linux-x64"
for arg in "$@"; do
	case "$arg" in
		--dry-run) dry_run=1 ;;
		-h|--help) usage; exit 0 ;;
		-*) die "unknown option: $arg" ;;
		*) target=$arg ;;
	esac
done

case " $VERIFIED_TARGETS " in
	*" $target "*) ;;
	*) die "refusing to package unverified target '$target' (verified: $VERIFIED_TARGETS)" ;;
esac

case "$target" in
	darwin-arm64) source_artifact="packages/coding-agent/binaries/${LEGACY_BINARY_NAME}-darwin-arm64" ;;
	darwin-x64) source_artifact="packages/coding-agent/binaries/${LEGACY_BINARY_NAME}-darwin-x64" ;;
	linux-x64) source_artifact="packages/coding-agent/binaries/${LEGACY_BINARY_NAME}-linux-x64" ;;
	linux-arm64) source_artifact="packages/coding-agent/binaries/${LEGACY_BINARY_NAME}-linux-arm64" ;;
	linux-musl-x64) source_artifact="packages/coding-agent/binaries/${LEGACY_BINARY_NAME}-linux-musl-x64" ;;
	linux-musl-arm64) source_artifact="packages/coding-agent/binaries/${LEGACY_BINARY_NAME}-linux-musl-arm64" ;;
	win32-x64) source_artifact="packages/coding-agent/binaries/${LEGACY_BINARY_NAME}-windows-x64.exe" ;;
	*) die "unknown target: $target" ;;
esac

artifact_name="${CLI_NAME}-${target}"
case "$target" in
	win32-*) artifact_name="${artifact_name}.exe" ;;
esac

if [ "$dry_run" -eq 1 ]; then
	exec bun scripts/ci-release-build-binaries.ts --dry-run --targets "$target"
fi

bun scripts/ci-release-build-binaries.ts --targets "$target"
[ -x "$source_artifact" ] || die "builder did not create executable $source_artifact"

version_output=$($source_artifact --version 2>&1) || die "$source_artifact did not start for --version"
[ "$version_output" = "$EXPECTED_VERSION_OUTPUT" ] || die "unexpected --version output: $version_output"

# Native-dependent commands force the compiled-in addon archive to extract and
# load. A plain --version exits before native initialization and is not enough.
proof_home=$(mktemp -d "${TMPDIR:-/tmp}/${CLI_NAME}-native-proof.XXXXXX")
trap 'rm -rf "$proof_home"' EXIT HUP INT TERM
HOME="$proof_home" "$source_artifact" grep --help >/dev/null 2>&1 || 
	die "embedded native addon failed to extract or load"

mkdir -p "$DIST_DIR"
cp "$source_artifact" "$DIST_DIR/$artifact_name"
chmod 755 "$DIST_DIR/$artifact_name"
bun scripts/ci-release-checksums.ts "$DIST_DIR/SHA256SUMS.txt" "$DIST_DIR/$artifact_name"
cp install.sh scripts/release-v01/notes.md "$DIST_DIR/"

# fix-dt-verdef.ts is intentionally not run here: it is required only after a
# Linux packaging chain changes ELF dynamic entries with patchelf. These raw Bun
# artifacts are not patched.
printf 'Staged %s v%s: %s\n' "$PRODUCT_NAME" "$PRODUCT_VERSION" "$DIST_DIR/$artifact_name"
printf 'Verified: %s\n' "$version_output"
