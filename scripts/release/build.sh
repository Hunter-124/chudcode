#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"

PRODUCT_NAME=$(bun -e 'import {PRODUCT_NAME} from "./packages/coding-agent/src/brand.ts"; process.stdout.write(PRODUCT_NAME)')
CLI_NAME=$(bun -e 'import {PRODUCT_RELEASE_ASSET_PREFIX} from "./packages/coding-agent/src/brand.ts"; process.stdout.write(PRODUCT_RELEASE_ASSET_PREFIX)')
VERIFIED_TARGETS="${CHUDCODE_VERIFIED_TARGETS:-linux-x64}"
STAGE_GUI="${CHUDCODE_STAGE_GUI:-0}"
STAGE_VISION="${CHUDCODE_STAGE_VISION:-0}"
ORT_VERSION="1.28.1"
ORT_LINUX_X64_SHA256="2529aef968d0ad0603365054bc46ebefa7f0fe3bc12f28c5f729c99ddffe2a81"
ORT_LINUX_X64_URL="https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/onnxruntime-linux-x64-${ORT_VERSION}.tgz"
VISION_ARCHIVE_NAME="${CLI_NAME}-vision-linux-x64.tar.gz"


die() {
	printf '%s\n' "error: $*" >&2
	exit 1
}

# The product version and asset names come from the binary's brand contract.
PRODUCT_VERSION=$(bun -e 'import {PRODUCT_SEMVER} from "./packages/coding-agent/src/brand.ts"; process.stdout.write(PRODUCT_SEMVER)')
RELEASE_REPOSITORY=$(bun -e 'import {PRODUCT_RELEASE_REPO} from "./packages/coding-agent/src/brand.ts"; process.stdout.write(PRODUCT_RELEASE_REPO)')
RELEASE_TAG_PREFIX=$(bun -e 'import {PRODUCT_RELEASE_TAG_PREFIX} from "./packages/coding-agent/src/brand.ts"; process.stdout.write(PRODUCT_RELEASE_TAG_PREFIX)')
DIST_DIR="${CHUDCODE_DIST_DIR:-dist/chudcode-v${PRODUCT_VERSION}}"
EXPECTED_VERSION_OUTPUT=$(bun -e 'import {PRODUCT_VERSION} from "./packages/coding-agent/src/brand.ts"; process.stdout.write(PRODUCT_VERSION)')

# `install.sh` is fetched by users before any of this repo exists on their disk,
# so its version and repository must be baked in — but they must still agree
# with what the binary reports, or the installer verifies a version that never
# ships and aborts every install.
installer_version=$(sed -n 's/^PRODUCT_VERSION="\(.*\)"$/\1/p' install.sh)
installer_repo=$(sed -n 's/^RELEASE_REPOSITORY="\(.*\)"$/\1/p' install.sh)
[ "$installer_version" = "$PRODUCT_VERSION" ] ||
	die "install.sh pins PRODUCT_VERSION=$installer_version but brand says $PRODUCT_VERSION"
[ "$installer_repo" = "$RELEASE_REPOSITORY" ] ||
	die "install.sh pins RELEASE_REPOSITORY=$installer_repo but brand says $RELEASE_REPOSITORY"
installer_tag=$(sed -n 's/^RELEASE_TAG="\(.*\)"$/\1/p' install.sh)
expected_installer_tag="${RELEASE_TAG_PREFIX}\${PRODUCT_VERSION}"
[ "$installer_tag" = "$expected_installer_tag" ] ||
	die "install.sh pins RELEASE_TAG=$installer_tag but brand implies $expected_installer_tag"
RELEASE_TAG="${RELEASE_TAG_PREFIX}${PRODUCT_VERSION}"


download_file() {
	url=$1
	destination=$2
	if command -v curl >/dev/null 2>&1; then
		curl -fL --retry 3 -o "$destination" "$url"
	elif command -v wget >/dev/null 2>&1; then
		wget -O "$destination" "$url"
	else
		die "curl or wget is required to download ONNX Runtime"
	fi
}

stage_vision_linux_x64() {
	cargo build --release -p chud-vision
	[ -x target/release/chud-vision ] || die "cargo did not create target/release/chud-vision"

	vision_tmp=$(mktemp -d "${TMPDIR:-/tmp}/${CLI_NAME}-vision.XXXXXX")
	ort_archive="$vision_tmp/onnxruntime.tgz"
	download_file "$ORT_LINUX_X64_URL" "$ort_archive"
	printf '%s  %s\n' "$ORT_LINUX_X64_SHA256" "$ort_archive" | sha256sum -c - >/dev/null ||
		die "ONNX Runtime archive checksum mismatch"
	tar -xzf "$ort_archive" -C "$vision_tmp"

	ort_root="$vision_tmp/onnxruntime-linux-x64-${ORT_VERSION}"
	[ -f "$ort_root/lib/libonnxruntime.so.${ORT_VERSION}" ] ||
		die "ONNX Runtime archive is missing libonnxruntime.so.${ORT_VERSION}"
	[ -f "$ort_root/LICENSE" ] || die "ONNX Runtime archive is missing its license"

	bundle="$vision_tmp/${CLI_NAME}-vision-linux-x64"
	mkdir -p "$bundle"
	cp target/release/chud-vision "$bundle/"
	chmod 755 "$bundle/chud-vision"
	cp -P "$ort_root"/lib/libonnxruntime.so* "$bundle/"
	cp "$ort_root/LICENSE" "$bundle/ONNXRUNTIME-LICENSE"
	tar -czf "$DIST_DIR/$VISION_ARCHIVE_NAME" -C "$vision_tmp" "${CLI_NAME}-vision-linux-x64"
	rm -rf "$vision_tmp"
	vision_tmp=""
}

usage() {
	cat <<EOF
Usage: scripts/release/build.sh [--dry-run] [target]

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
	darwin-x64) source_artifact="packages/coding-agent/binaries/$(bun -e 'import {releaseBinaryName} from "./packages/coding-agent/src/brand.ts"; process.stdout.write(releaseBinaryName({platform:"darwin",arch:"x64"}))')" ;;
	linux-x64) source_artifact="packages/coding-agent/binaries/$(bun -e 'import {releaseBinaryName} from "./packages/coding-agent/src/brand.ts"; process.stdout.write(releaseBinaryName({platform:"linux",arch:"x64"}))')" ;;
	win32-x64) source_artifact="packages/coding-agent/binaries/$(bun -e 'import {releaseBinaryName} from "./packages/coding-agent/src/brand.ts"; process.stdout.write(releaseBinaryName({platform:"win32",arch:"x64"}))')" ;;
	*) die "unknown target: $target" ;;
esac

artifact_name=${source_artifact##*/}

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
vision_tmp=""
cleanup() {
	rm -rf "$proof_home"
	[ -z "$vision_tmp" ] || rm -rf "$vision_tmp"
}
trap cleanup EXIT HUP INT TERM
HOME="$proof_home" "$source_artifact" grep --help >/dev/null 2>&1 || 
	die "embedded native addon failed to extract or load"

mkdir -p "$DIST_DIR"
cp "$source_artifact" "$DIST_DIR/$artifact_name"
chmod 755 "$DIST_DIR/$artifact_name"
if [ "$target" = "linux-x64" ] && [ "$STAGE_VISION" = "1" ]; then
	stage_vision_linux_x64
	bun scripts/ci-release-checksums.ts "$DIST_DIR/SHA256SUMS.txt" \
		"$DIST_DIR/$artifact_name" "$DIST_DIR/$VISION_ARCHIVE_NAME"
else
	bun scripts/ci-release-checksums.ts "$DIST_DIR/SHA256SUMS.txt" "$DIST_DIR/$artifact_name"
fi
cp install.sh "$DIST_DIR/"
if [ "$target" = "linux-x64" ] && [ "$STAGE_GUI" = "1" ]; then
	CHUDCODE_DIST_DIR="$DIST_DIR" scripts/release/stage-gui.sh "$target"
fi

# fix-dt-verdef.ts is intentionally not run here: it is required only after a
# Linux packaging chain changes ELF dynamic entries with patchelf. These raw Bun
# artifacts are not patched.
printf 'Staged %s v%s: %s\n' "$PRODUCT_NAME" "$PRODUCT_VERSION" "$DIST_DIR/$artifact_name"
printf 'Verified: %s\n' "$version_output"
