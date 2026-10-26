#!/bin/sh
set -eu

PRODUCT_NAME="Chudcode"
PRODUCT_VERSION="0.4.4"
RELEASE_TAG="chudcode-v${PRODUCT_VERSION}"
RELEASE_REPOSITORY="Hunter-124/chudcode"
INSTALL_DIR="${CHUDCODE_INSTALL_DIR:-${HOME}/.local/bin}"
DATA_DIR="${CHUDCODE_DATA_DIR:-${HOME}/.local/share}"
INSTALL_ROOT="${CHUDCODE_INSTALL_ROOT:-${DATA_DIR}/chudcode}"
ARTIFACT_DIR="${CHUDCODE_ARTIFACT_DIR:-}"
RELEASE_BASE_URL="${CHUDCODE_RELEASE_BASE_URL:-}"
INSTALL_DESKTOP="${CHUDCODE_INSTALL_DESKTOP:-1}"
FORCE="${CHUDCODE_FORCE:-0}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
command_exists() { command -v "$1" >/dev/null 2>&1; }

case "$INSTALL_DESKTOP" in 0|1) ;; *) die "CHUDCODE_INSTALL_DESKTOP must be 0 or 1" ;; esac

# Chudware owns its embedded runtime. The standalone installer never writes to a
# marked or recognizably private Chudware runtime, even with CHUDCODE_FORCE=1.
assert_standalone_destination() {
	candidate=$1
	case "$candidate" in
		*chudware*/embedded*|*chudware*/private*|*Chudware*/embedded*|*Chudware*/private*)
			die "refusing to overwrite a Chudware-private embedded runtime: $candidate" ;;
	esac
	probe=$candidate
	while [ -n "$probe" ] && [ "$probe" != "/" ]; do
		[ ! -e "$probe/.chudware-private-runtime" ] ||
			die "refusing to overwrite a Chudware-private embedded runtime: $candidate"
		parent=$(dirname "$probe")
		[ "$parent" != "$probe" ] || break
		probe=$parent
	done
}
assert_standalone_destination "$INSTALL_ROOT"
assert_standalone_destination "$INSTALL_DIR"

os_name=$(uname -s 2>/dev/null || true)
arch_name=$(uname -m 2>/dev/null || true)
case "$arch_name" in
	x86_64|amd64) release_arch="x64" ;;
	*) die "unsupported architecture: $arch_name" ;;
esac
case "$os_name" in
	Linux) release_os="linux"; archive_ext="tar.gz"; exe_suffix="" ;;
	Darwin) release_os="macos"; archive_ext="tar.gz"; exe_suffix="" ;;
	MINGW*|MSYS*|CYGWIN*) release_os="windows"; archive_ext="zip"; exe_suffix=".exe" ;;
	*) die "unsupported operating system: $os_name" ;;
esac
target="${release_os}-${release_arch}"
artifact_name="chudcode-desktop-${target}.${archive_ext}"

case "$target" in
	linux-x64|macos-x64|windows-x64) ;;
	*) die "no canonical desktop artifact for $target" ;;
esac

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/chudcode-install.XXXXXX")
stage_dir=""
release_dir=""
replaced_release_backup=""
activated=0
success=0
old_current=""
cleanup() {
	if [ "$success" != "1" ] && [ "$activated" = "1" ]; then
		if [ -n "$old_current" ]; then
			rollback_link="$INSTALL_ROOT/.current.rollback.$$"
			ln -s "$old_current" "$rollback_link" 2>/dev/null && mv -f "$rollback_link" "$INSTALL_ROOT/current" || true
		else
			rm -f "$INSTALL_ROOT/current"
		fi
	fi
	if [ "$success" != "1" ] && [ -n "$replaced_release_backup" ] && [ -n "$release_dir" ]; then
		rm -rf "$release_dir"
		mv "$replaced_release_backup" "$release_dir" 2>/dev/null || true
		replaced_release_backup=""
	fi
	rm -rf "$work_dir"
	[ -z "$stage_dir" ] || rm -rf "$stage_dir"
}
trap cleanup EXIT HUP INT TERM

download_url() {
	url=$1; destination=$2
	if command_exists curl; then
		if [ -n "${GITHUB_TOKEN:-}" ]; then
			curl -fL --retry 3 -H "Authorization: Bearer ${GITHUB_TOKEN}" -o "$destination" "$url"
		else
			curl -fL --retry 3 -o "$destination" "$url"
		fi
	elif command_exists wget; then
		if [ -n "${GITHUB_TOKEN:-}" ]; then
			wget --header="Authorization: Bearer ${GITHUB_TOKEN}" -O "$destination" "$url"
		else
			wget -O "$destination" "$url"
		fi
	else
		die "curl or wget is required to download release assets"
	fi
}

fetch_asset() {
	asset=$1; destination=$2
	if [ -n "$ARTIFACT_DIR" ]; then
		[ -f "$ARTIFACT_DIR/$asset" ] || die "release asset not found: $asset"
		cp "$ARTIFACT_DIR/$asset" "$destination"
	elif [ -n "$RELEASE_BASE_URL" ]; then
		download_url "${RELEASE_BASE_URL%/}/$asset" "$destination"
	elif command_exists gh; then
		gh release download "$RELEASE_TAG" --repo "$RELEASE_REPOSITORY" --pattern "$asset" --output "$destination"
	else
		download_url "https://github.com/${RELEASE_REPOSITORY}/releases/download/${RELEASE_TAG}/$asset" "$destination"
	fi
}

sha256_file() {
	if command_exists sha256sum; then value=$(sha256sum "$1")
	elif command_exists shasum; then value=$(shasum -a 256 "$1")
	else die "sha256sum or shasum is required to verify release artifacts"
	fi
	printf '%s\n' "${value%% *}"
}

checksum_for() {
	wanted=$1; checksum_file=$2
	while read -r checksum filename; do
		[ "$filename" = "$wanted" ] || continue
		case "$checksum" in *[!0-9a-fA-F]*|'') return 1 ;; esac
		[ "${#checksum}" = "64" ] || return 1
		printf '%s\n' "$checksum"
		return 0
	done < "$checksum_file"
	return 1
}

manifest_hash_for() {
	wanted=$1; manifest=$2
	awk -v wanted="$wanted" '
		$0 ~ "\\\"file\\\": \\\"" wanted "\\\"" { found=1; next }
		found && /"sha256":/ { gsub(/.*"sha256": "/, ""); gsub(/".*/, ""); print; exit }
	' "$manifest"
}

manifest_target_for() {
	wanted=$1; manifest=$2
	awk -v wanted="$wanted" '
		/"target":/ { target=$0; gsub(/.*"target": "/, "", target); gsub(/".*/, "", target) }
		$0 ~ "\\\"file\\\": \\\"" wanted "\\\"" { print target; exit }
	' "$manifest"
}

verify_version_output() {
	executable=$1
	output=$("$executable" --version 2>&1) || die "$executable failed its --version check"
	case "$executable" in
		*/chud|*/chud.exe)
			[ "$output" = "Chudcode v${PRODUCT_VERSION}" ] ||
				die "$executable returned unexpected --version output: $output"
			;;
		*/chudcode-desktop|*/chudcode-desktop.exe)
			[ "$output" = "$PRODUCT_VERSION" ] || die "$executable returned unexpected --version output: $output"
			;;
		*) die "no version-output contract for $executable" ;;
	esac
}

checksums="$work_dir/SHA256SUMS.txt"
manifest="$work_dir/release-manifest.json"
archive="$work_dir/$artifact_name"
fetch_asset "SHA256SUMS.txt" "$checksums"
fetch_asset "release-manifest.json" "$manifest"

manifest_expected=$(checksum_for "release-manifest.json" "$checksums") ||
	die "SHA256SUMS.txt has no release-manifest.json entry"
[ "$(sha256_file "$manifest")" = "$manifest_expected" ] || die "release-manifest.json checksum mismatch"

manifest_version=$(sed -n 's/^[[:space:]]*"productVersion": "\([^"]*\)",*$/\1/p' "$manifest")
[ "$manifest_version" = "$PRODUCT_VERSION" ] || die "release manifest product version mismatch"
awk '
	/"rpc": \[/ {
		getline
		first = $0
		getline
		second = $0
		gsub(/[^0-9]/, "", first)
		gsub(/[^0-9]/, "", second)
		if (first == "1" && second == "2") found = 1
	}
	END { exit(found ? 0 : 1) }
' "$manifest" || die "release manifest RPC protocol version mismatch"
grep -q '"desktop": 1' "$manifest" || die "release manifest desktop protocol version mismatch"
manifest_artifact_count=$(grep -c '^[[:space:]]*"file": "chudcode-desktop-' "$manifest" || true)
[ "$manifest_artifact_count" = "3" ] || die "release manifest does not contain the supported three-target set"
for canonical_asset in \
	chudcode-desktop-linux-x64.tar.gz \
	chudcode-desktop-macos-x64.tar.gz \
	chudcode-desktop-windows-x64.zip; do
	grep -q "\"file\": \"$canonical_asset\"" "$manifest" || die "release manifest is missing $canonical_asset"
done
[ "$(manifest_target_for "$artifact_name" "$manifest")" = "$target" ] || die "release manifest target mismatch"

fetch_asset "$artifact_name" "$archive"
archive_expected=$(checksum_for "$artifact_name" "$checksums") || die "SHA256SUMS.txt has no entry for $artifact_name"
archive_actual=$(sha256_file "$archive")
[ "$archive_actual" = "$archive_expected" ] || die "checksum mismatch for $artifact_name"
[ "$(manifest_hash_for "$artifact_name" "$manifest")" = "$archive_actual" ] || die "release manifest hash mismatch for $artifact_name"

listing="$work_dir/archive.list"
if [ "$archive_ext" = "zip" ]; then
	command_exists unzip || die "unzip is required for Windows desktop archives"
	unzip -Z1 "$archive" > "$listing" || die "could not inspect $artifact_name"
else
	command_exists tar || die "tar is required for desktop archives"
	tar -tzf "$archive" > "$listing" || die "could not inspect $artifact_name"
fi
while IFS= read -r member; do
	case "$member" in
		/*|../*|*/../*|*/..) die "archive contains an unsafe path: $member" ;;
		.git/*|*/.git/*|node_modules/*|*/node_modules/*|src/*|*/src/*|*.c|*.cc|*.cpp|*.cxx|*.h|*.hh|*.hpp|*.hxx|*.m|*.mm|*.py|*.pyc|*.pyo|*.rs|*.ts|*.tsx|*.jsx|*.map|bun.lock|*/bun.lock|package.json|*/package.json|CMakeLists.txt|*/CMakeLists.txt)
			die "archive is not source-free: $member" ;;
	esac
	case "$member" in
		*.js)
			case "$member" in web/*|./web/*) ;; *) die "archive contains JavaScript outside compiled web assets: $member" ;; esac
			;;
	esac
done < "$listing"

payload="$work_dir/payload"
mkdir "$payload"
if [ "$archive_ext" = "zip" ]; then unzip -q "$archive" -d "$payload"
else tar -xzf "$archive" -C "$payload"
fi

for required in "chud${exe_suffix}" "chudcode-desktop${exe_suffix}" "chudcode-gui${exe_suffix}" VERSION NOTICE THIRD-PARTY-NOTICES.txt; do
	[ -f "$payload/$required" ] || die "$artifact_name is missing $required"
done
[ -d "$payload/web" ] || die "$artifact_name is missing web assets"
[ -d "$payload/assets" ] || die "$artifact_name is missing native GUI assets"
[ -s "$payload/NOTICE" ] || die "$artifact_name contains an empty NOTICE"
[ -s "$payload/THIRD-PARTY-NOTICES.txt" ] || die "$artifact_name contains empty third-party notices"
[ "$(cat "$payload/VERSION")" = "$PRODUCT_VERSION" ] || die "$artifact_name VERSION mismatch"
for notice_token in GLFW ImGui IXWebSocket libvterm stb_image Rubik "JetBrains Mono" Monaco xterm.js Bun; do
	grep -q "$notice_token" "$payload/THIRD-PARTY-NOTICES.txt" || die "$artifact_name notices omit $notice_token"
done
chmod 755 "$payload/chud${exe_suffix}" "$payload/chudcode-desktop${exe_suffix}" "$payload/chudcode-gui${exe_suffix}"
verify_version_output "$payload/chud${exe_suffix}"
verify_version_output "$payload/chudcode-desktop${exe_suffix}"


mkdir -p "$INSTALL_ROOT/releases" "$INSTALL_DIR"
assert_standalone_destination "$INSTALL_ROOT/releases"
release_dir="$INSTALL_ROOT/releases/${PRODUCT_VERSION}-${target}"
stage_dir=$(mktemp -d "$INSTALL_ROOT/releases/.${PRODUCT_VERSION}-${target}.XXXXXX")
cp -R "$payload/." "$stage_dir/"

# Validate the installed copy before it can become current.
verify_version_output "$stage_dir/chud${exe_suffix}"
[ "$(cat "$stage_dir/VERSION")" = "$PRODUCT_VERSION" ] || die "staged VERSION changed"

assert_install_link_replaceable() {
	existing="$INSTALL_DIR/$1"
	if [ -e "$existing" ] || [ -L "$existing" ]; then
		if [ -L "$existing" ]; then
			existing_target=$(readlink "$existing")
			case "$existing_target" in *chudware*|*Chudware*) die "refusing to replace Chudware-private link $existing" ;; esac
		elif [ "$FORCE" != "1" ]; then
			die "$existing is not a managed symlink; set CHUDCODE_FORCE=1 to replace it"
		fi
	fi
}
assert_install_link_replaceable "chud${exe_suffix}"
if [ "$INSTALL_DESKTOP" = "1" ]; then
	assert_install_link_replaceable "chudcode-desktop${exe_suffix}"
	assert_install_link_replaceable "chudcode-gui${exe_suffix}"
fi

if [ -L "$INSTALL_ROOT/current" ]; then old_current=$(readlink "$INSTALL_ROOT/current")
elif [ -e "$INSTALL_ROOT/current" ]; then die "$INSTALL_ROOT/current exists and is not a managed symlink"
fi

if [ -e "$release_dir" ]; then
	[ "$FORCE" = "1" ] || {
		[ "$(sha256_file "$release_dir/chud${exe_suffix}")" = "$(sha256_file "$stage_dir/chud${exe_suffix}")" ] ||
			die "$release_dir already exists with different contents; set CHUDCODE_FORCE=1 to replace it"
	}
	replaced_release_backup="$INSTALL_ROOT/releases/.old-${PRODUCT_VERSION}-${target}.$$"
	mv "$release_dir" "$replaced_release_backup"
	mv "$stage_dir" "$release_dir"
	stage_dir=""
else
	mv "$stage_dir" "$release_dir"
	stage_dir=""
fi

next_current="$INSTALL_ROOT/.current.$$"
ln -s "$release_dir" "$next_current"
mv -f "$next_current" "$INSTALL_ROOT/current"
activated=1

install_link() {
	name=$1; destination=$2
	existing="$INSTALL_DIR/$name"
	if [ -e "$existing" ] || [ -L "$existing" ]; then
		if [ -L "$existing" ]; then
			existing_target=$(readlink "$existing")
			case "$existing_target" in *chudware*|*Chudware*) die "refusing to replace Chudware-private link $existing" ;; esac
		elif [ "$FORCE" != "1" ]; then
			die "$existing is not a managed symlink; set CHUDCODE_FORCE=1 to replace it"
		fi
	fi
	tmp_link="$INSTALL_DIR/.${name}.$$"
	ln -s "$destination" "$tmp_link"
	mv -f "$tmp_link" "$existing"
}

install_link "chud${exe_suffix}" "$INSTALL_ROOT/current/chud${exe_suffix}"
if [ "$INSTALL_DESKTOP" = "1" ]; then
	install_link "chudcode-desktop${exe_suffix}" "$INSTALL_ROOT/current/chudcode-desktop${exe_suffix}"
	install_link "chudcode-gui${exe_suffix}" "$INSTALL_ROOT/current/chudcode-gui${exe_suffix}"
fi

verify_version_output "$INSTALL_DIR/chud${exe_suffix}"
success=1
[ -z "$replaced_release_backup" ] || rm -rf "$replaced_release_backup"
replaced_release_backup=""
say "Installed $PRODUCT_NAME $PRODUCT_VERSION for $target"
say "CLI: $INSTALL_DIR/chud${exe_suffix}"
if [ "$INSTALL_DESKTOP" = "1" ]; then say "Desktop: $INSTALL_DIR/chudcode-desktop${exe_suffix}"
else say "Desktop launchers were not exposed (CLI-only installation)."
fi
case ":${PATH:-}:" in *":$INSTALL_DIR:"*) ;; *) say "Add $INSTALL_DIR to PATH." ;; esac
