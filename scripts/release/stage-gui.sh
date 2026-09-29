#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"

PRODUCT_NAME="Chudcode"
PRODUCT_VERSION=$(bun -e 'import {PRODUCT_SEMVER} from "./packages/coding-agent/src/brand.ts"; process.stdout.write(PRODUCT_SEMVER)')
GUI_NAME="chudcode-gui"
TARGET="${CHUDCODE_GUI_TARGET:-linux-x64}"
CAD_ROOT="${CHUDCODE_CAD_ROOT:-/home/hunter/Repositories/CAD}"
CAD_REF="${CHUDCODE_CAD_REF:-}"
DIST_DIR="${CHUDCODE_DIST_DIR:-dist/chudcode-v${PRODUCT_VERSION}}"
CANONICAL_CAD_COMMIT="20c2bf81ec2479a82b4772e9c2afe1a6b4b23466"
LOCK_SCHEMA="1"


bundle_name="${GUI_NAME}-${TARGET}"
archive_name="${bundle_name}.tar.gz"

die() {
	printf '%s\n' "error: $*" >&2
	exit 1
}

usage() {
	cat <<EOF
Usage: scripts/release/stage-gui.sh [linux-x64]
       scripts/release/stage-gui.sh --verify [bundle-dir-or-tar.gz]

Build the canonical CAD host in Code mode and stage ${PRODUCT_NAME}'s GUI.
CHUDCODE_CAD_ROOT defaults to /home/hunter/Repositories/CAD. Set
CHUDCODE_CAD_REF to require a particular checked-out CAD commit.
EOF
}

sha256_file() {
	if command -v sha256sum >/dev/null 2>&1; then
		value=$(sha256sum "$1")
	else
		command -v shasum >/dev/null 2>&1 || die "sha256sum or shasum is required"
		value=$(shasum -a 256 "$1")
	fi
	printf '%s\n' "${value%% *}"
}

manifest_entries() {
	bundle=$1
	find "$bundle" -type f ! -name CHUDCODE_GUI.lock -print |
		LC_ALL=C sort |
		while IFS= read -r file; do
			relative=${file#"$bundle/"}
			printf 'file %s %s\n' "$(sha256_file "$file")" "$relative"
		done
}

write_lock() {
	bundle=$1
	cad_remote=$2
	cad_commit=$3
	lock="$bundle/CHUDCODE_GUI.lock"
	{
		printf 'schema %s\n' "$LOCK_SCHEMA"
		printf 'target %s\n' "$TARGET"
		printf 'cad_remote %s\n' "$cad_remote"
		printf 'cad_commit %s\n' "$cad_commit"
		printf 'binary_sha256 %s\n' "$(sha256_file "$bundle/$GUI_NAME")"
		manifest_entries "$bundle"
	} > "$lock"
}

verify_bundle() {
	bundle=$1
	[ -d "$bundle" ] || die "GUI bundle directory not found: $bundle"
	lock="$bundle/CHUDCODE_GUI.lock"
	[ -f "$lock" ] || die "missing CHUDCODE_GUI.lock"
	[ -x "$bundle/$GUI_NAME" ] || die "missing executable $GUI_NAME"
	[ -d "$bundle/assets" ] || die "missing adjacent assets tree"
	[ -f "$bundle/packaging/linux/chudcode.desktop" ] || die "missing chudcode.desktop"

	schema=$(sed -n 's/^schema //p' "$lock")
	target=$(sed -n 's/^target //p' "$lock")
	binary_hash=$(sed -n 's/^binary_sha256 //p' "$lock")
	[ "$schema" = "$LOCK_SCHEMA" ] || die "unsupported GUI lock schema: $schema"
	[ "$target" = "$TARGET" ] || die "GUI lock target '$target' does not match '$TARGET'"
	[ "$binary_hash" = "$(sha256_file "$bundle/$GUI_NAME")" ] || die "GUI binary checksum mismatch"

	symlinks=$(find "$bundle" -type l -print)
	[ -z "$symlinks" ] || die "GUI bundle contains untracked symlink(s): $symlinks"
	source_files=$(find "$bundle" -type f \( \
		-name '*.c' -o -name '*.cc' -o -name '*.cpp' -o -name '*.h' -o -name '*.hpp' -o \
		-name '*.m' -o -name '*.mm' -o -name '*.py' -o -name '*.rs' -o \
		-name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \) -print)
	[ -z "$source_files" ] || die "GUI bundle contains private source file(s): $source_files"
	recorded=$(mktemp "${TMPDIR:-/tmp}/chudcode-gui-recorded.XXXXXX")
	actual=$(mktemp "${TMPDIR:-/tmp}/chudcode-gui-actual.XXXXXX")
	sed -n '/^file /p' "$lock" > "$recorded"
	manifest_entries "$bundle" > "$actual"
	if ! cmp -s "$recorded" "$actual"; then
		rm -f "$recorded" "$actual"
		die "GUI bundle has missing, extra, or changed files"
	fi
	rm -f "$recorded" "$actual"
}

verify_path() {
	path=$1
	case "$path" in
		*.tar.gz)
			verify_tmp=$(mktemp -d "${TMPDIR:-/tmp}/chudcode-gui-verify.XXXXXX")
			tar -xzf "$path" -C "$verify_tmp"
			verify_bundle "$verify_tmp/$bundle_name"
			rm -rf "$verify_tmp"
			;;
		*) verify_bundle "$path" ;;
	esac
	printf 'Verified %s\n' "$path"
}

if [ "${1:-}" = "--verify" ]; then
	shift
	verify_path "${1:-$DIST_DIR/$archive_name}"
	exit 0
fi
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
	usage
	exit 0
fi
if [ "$#" -gt 1 ]; then
	usage >&2
	exit 1
fi
if [ "$#" -eq 1 ]; then TARGET=$1; bundle_name="${GUI_NAME}-${TARGET}"; archive_name="${bundle_name}.tar.gz"; fi
[ "$TARGET" = "linux-x64" ] || die "GUI release target is currently linux-x64 only"
[ -e "$CAD_ROOT/.git" ] || die "CHUDCODE_CAD_ROOT is not a Git checkout: $CAD_ROOT"

cad_head=$(git -C "$CAD_ROOT" rev-parse HEAD)
if [ -n "$CAD_REF" ]; then
	cad_commit=$(git -C "$CAD_ROOT" rev-parse "${CAD_REF}^{commit}")
	[ "$cad_head" = "$cad_commit" ] || die "CAD HEAD is $cad_head; check out CHUDCODE_CAD_REF $cad_commit before building"
else
	cad_commit=$cad_head
	git -C "$CAD_ROOT" merge-base --is-ancestor "$CANONICAL_CAD_COMMIT" "$cad_commit" ||
		die "CAD HEAD $cad_commit does not contain canonical Code UI commit $CANONICAL_CAD_COMMIT"
fi

cad_changes=$(git -C "$CAD_ROOT" status --porcelain --untracked-files=all -- host)
[ -z "$cad_changes" ] || die "CAD host sources are dirty; commit or remove changes before release:\n$cad_changes"
cad_remote=$(git -C "$CAD_ROOT" remote get-url origin)

cmake -S "$CAD_ROOT/host" -B "$CAD_ROOT/host/build-linux" -G Ninja \
	-DCMAKE_BUILD_TYPE=Release -DCHUDWARE_ENABLE_CEF=OFF
cmake --build "$CAD_ROOT/host/build-linux" --target Chudware test_code_acp_transport test_code_workspace_mapping --parallel
ctest --test-dir "$CAD_ROOT/host/build-linux" --output-on-failure \
	-R '^(test_code_acp_transport|test_code_workspace_mapping)$'

source_bin="$CAD_ROOT/host/build-linux/bin"
[ -x "$source_bin/chudware" ] || die "CAD build did not produce $source_bin/chudware"
[ -d "$source_bin/assets" ] || die "CAD build has no adjacent assets tree"
[ -f "$repo_root/packaging/linux/chudcode.desktop" ] || die "missing packaging/linux/chudcode.desktop"

stage_root=$(mktemp -d "${TMPDIR:-/tmp}/chudcode-gui-stage.XXXXXX")
trap 'rm -rf "$stage_root"' EXIT HUP INT TERM
bundle="$stage_root/$bundle_name"
mkdir -p "$bundle/packaging/linux" "$bundle/icons/hicolor" \
	"$bundle/assets/fonts" "$bundle/assets/icons" "$bundle/assets/appicon"
cp "$source_bin/chudware" "$bundle/$GUI_NAME"
chmod 755 "$bundle/$GUI_NAME"
# Runtime-only whitelist. Never copy CAD's complete assets directory: it also contains
# generator/test sources and atlas recipes that are not needed by the application.
cp "$source_bin"/assets/fonts/*.ttf "$bundle/assets/fonts/"
cp "$source_bin/assets/icons/atlas.json" \
	"$source_bin/assets/icons/atlas_dark.png" \
	"$source_bin/assets/icons/atlas_light.png" "$bundle/assets/icons/"
cp "$source_bin/assets/logo_icon.png" \
	"$source_bin/assets/logo_wordmark.png" \
	"$source_bin/assets/logo_wordmark_dark.png" "$bundle/assets/"
cp "$source_bin"/assets/appicon/*.png "$bundle/assets/appicon/"
cp "$repo_root/packaging/linux/chudcode.desktop" "$bundle/packaging/linux/chudcode.desktop"
cp "$repo_root/LICENSE" "$repo_root/NOTICE" "$bundle/"

for size in 16 24 32 48 64 128 256; do
	source_icon="$repo_root/assets/appicon/$size.png"
	[ -f "$source_icon" ] || die "missing Chudcode app icon: $source_icon"
	icon_dir="$bundle/icons/hicolor/${size}x${size}/apps"
	mkdir -p "$icon_dir"
	cp "$source_icon" "$icon_dir/chudcode.png"
done

write_lock "$bundle" "$cad_remote" "$cad_commit"
verify_bundle "$bundle"
mkdir -p "$DIST_DIR"
tar -czf "$DIST_DIR/$archive_name" -C "$stage_root" "$bundle_name"
verify_path "$DIST_DIR/$archive_name"

checksum_file="$DIST_DIR/SHA256SUMS.txt"
checksum_tmp=$(mktemp "${TMPDIR:-/tmp}/chudcode-gui-checksums.XXXXXX")
if [ -f "$checksum_file" ]; then
	sed "/  $archive_name\$/d" "$checksum_file" > "$checksum_tmp"
fi
printf '%s  %s\n' "$(sha256_file "$DIST_DIR/$archive_name")" "$archive_name" >> "$checksum_tmp"
LC_ALL=C sort "$checksum_tmp" > "$checksum_file"
rm -f "$checksum_tmp"

printf 'Staged %s GUI: %s\n' "$PRODUCT_NAME" "$DIST_DIR/$archive_name"
printf 'CAD source: %s %s\n' "$cad_remote" "$cad_commit"
