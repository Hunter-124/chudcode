#!/bin/sh
set -eu

PRODUCT_NAME="Chudcode"
PRODUCT_VERSION="0.2.0"
UPSTREAM_VERSION="18.0.8"
CLI_NAME="chudcode"
GUI_NAME="chudcode-gui"
COMPAT_ALIAS="chudware-code"
SHORT_ALIAS="chcode"
LEGACY_ALIAS="omp"
RELEASE_TAG="chudcode-v${PRODUCT_VERSION}"
RELEASE_REPOSITORY="Hunter-124/chudcode"
EXPECTED_VERSION_OUTPUT="${CHUDCODE_EXPECTED_VERSION_OUTPUT:-${PRODUCT_NAME} v${PRODUCT_VERSION} (based on ${LEGACY_ALIAS} ${UPSTREAM_VERSION})}"
INSTALL_DIR="${CHUDCODE_INSTALL_DIR:-${HOME}/.local/bin}"
DATA_DIR="${CHUDCODE_DATA_DIR:-${HOME}/.local/share}"
ARTIFACT_DIR="${CHUDCODE_ARTIFACT_DIR:-}"
RELEASE_BASE_URL="${CHUDCODE_RELEASE_BASE_URL:-}"
NATIVE_ADDON_REQUIRED="${CHUDCODE_NATIVE_ADDON_REQUIRED:-0}"
NATIVE_ADDON_ARTIFACT="${CHUDCODE_NATIVE_ADDON_ARTIFACT:-}"
VISION_ARCHIVE_NAME="${CLI_NAME}-vision-linux-x64.tar.gz"
FORCE="${CHUDCODE_FORCE:-0}"

say() {
	printf '%s\n' "$*"
}

die() {
	printf '%s\n' "error: $*" >&2
	exit 1
}

command_exists() {
	command -v "$1" >/dev/null 2>&1
}

download_url() {
	url=$1
	destination=$2
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

try_fetch_asset() {
	asset=$1
	destination=$2
	if [ -n "$ARTIFACT_DIR" ]; then
		[ -f "$ARTIFACT_DIR/$asset" ] || return 1
		cp "$ARTIFACT_DIR/$asset" "$destination"
	elif [ -n "$RELEASE_BASE_URL" ]; then
		download_url "${RELEASE_BASE_URL%/}/$asset" "$destination"
	elif command_exists gh; then
		gh release download "$RELEASE_TAG" --repo "$RELEASE_REPOSITORY" --pattern "$asset" --output "$destination"
	else
		download_url "https://github.com/${RELEASE_REPOSITORY}/releases/download/${RELEASE_TAG}/$asset" "$destination"
	fi
}

fetch_asset() {
	try_fetch_asset "$1" "$2" || die "release asset not found: $1"
}

sha256_file() {
	if command_exists sha256sum; then
		value=$(sha256sum "$1")
	elif command_exists shasum; then
		value=$(shasum -a 256 "$1")
	else
		die "sha256sum or shasum is required to verify release artifacts"
	fi
	printf '%s\n' "${value%% *}"
}

checksum_for() {
	wanted=$1
	checksum_file=$2
	while read -r checksum filename; do
		if [ "$filename" = "$wanted" ]; then
			printf '%s\n' "$checksum"
			return 0
		fi
	done < "$checksum_file"
	return 1
}

verify_gui_lock() {
	bundle=$1
	lock="$bundle/CHUDCODE_GUI.lock"
	[ -f "$lock" ] || die "GUI archive is missing CHUDCODE_GUI.lock"
	[ "$(sed -n 's/^schema //p' "$lock")" = "1" ] || die "unsupported GUI lock schema"
	[ "$(sed -n 's/^target //p' "$lock")" = "$target" ] || die "GUI lock target mismatch"
	recorded=$(mktemp "${TMPDIR:-/tmp}/chudcode-gui-recorded.XXXXXX")
	actual=$(mktemp "${TMPDIR:-/tmp}/chudcode-gui-actual.XXXXXX")
	sed -n '/^file /p' "$lock" > "$recorded"
	find "$bundle" -type f ! -name CHUDCODE_GUI.lock -print |
		LC_ALL=C sort |
		while IFS= read -r file; do
			relative=${file#"$bundle/"}
			printf 'file %s %s\n' "$(sha256_file "$file")" "$relative"
		done > "$actual"
	if ! cmp -s "$recorded" "$actual"; then
		rm -f "$recorded" "$actual"
		die "GUI archive has missing, extra, or changed files"
	fi
	rm -f "$recorded" "$actual"
}

installed_product_version() {
	output=$1
	case "$output" in
		"$PRODUCT_NAME v"*)
			value=${output#"$PRODUCT_NAME v"}
			printf '%s\n' "${value%% *}"
			;;
	esac
}

is_newer_version() (
	candidate=$1
	current=$2
	old_ifs=$IFS
	IFS=.
	set -- $candidate
	candidate_major=${1:-0}; candidate_minor=${2:-0}; candidate_patch=${3:-0}
	set -- $current
	current_major=${1:-0}; current_minor=${2:-0}; current_patch=${3:-0}
	IFS=$old_ifs
	[ "$candidate_major" -gt "$current_major" ] ||
		{ [ "$candidate_major" -eq "$current_major" ] && [ "$candidate_minor" -gt "$current_minor" ]; } ||
		{ [ "$candidate_major" -eq "$current_major" ] && [ "$candidate_minor" -eq "$current_minor" ] && [ "$candidate_patch" -gt "$current_patch" ]; }
)

create_aliases() {
	ln -sf "$binary_filename" "$INSTALL_DIR/$compat_alias_filename"
	ln -sf "$binary_filename" "$INSTALL_DIR/$short_alias_filename"
	ln -sf "$binary_filename" "$INSTALL_DIR/$legacy_alias_filename"
}

print_path_hint() {
	case ":${PATH:-}:" in
		*":$INSTALL_DIR:"*) ;;
		*)
			say ""
			say "Add the install directory to PATH:"
			say "  export PATH=\"$INSTALL_DIR:\$PATH\""
			;;
	esac
}

os_name=$(uname -s 2>/dev/null || true)
arch_name=$(uname -m 2>/dev/null || true)

case "$arch_name" in
	x86_64|amd64) release_arch="x64" ;;
	aarch64|arm64) release_arch="arm64" ;;
	*) die "unsupported architecture: $arch_name" ;;
esac

case "$os_name" in
	Linux)
		release_os="linux"
		if command_exists ldd && ldd_output=$(ldd --version 2>&1); then
			case "$ldd_output" in *musl*) release_os="linux-musl" ;; esac
		fi
		;;
	Darwin) release_os="darwin" ;;
	MINGW*|MSYS*|CYGWIN*) release_os="win32" ;;
	*) die "unsupported operating system: $os_name" ;;
esac

case "$release_os-$release_arch" in
	darwin-arm64|darwin-x64|linux-x64|linux-arm64|linux-musl-x64|linux-musl-arm64|win32-x64)
		target="$release_os-$release_arch"
		;;
	*) die "no release target for $release_os/$release_arch" ;;
esac

binary_filename="$CLI_NAME"
compat_alias_filename="$COMPAT_ALIAS"
short_alias_filename="$SHORT_ALIAS"
legacy_alias_filename="$LEGACY_ALIAS"
artifact_name="${CLI_NAME}-${target}"
case "$release_os" in
	win32)
		binary_filename="${binary_filename}.exe"
		compat_alias_filename="${compat_alias_filename}.exe"
		short_alias_filename="${short_alias_filename}.exe"
		legacy_alias_filename="${legacy_alias_filename}.exe"
		artifact_name="${artifact_name}.exe"
		;;
esac
install_path="$INSTALL_DIR/$binary_filename"

mkdir -p "$INSTALL_DIR"
cli_current=0

if [ -e "$install_path" ] || [ -L "$install_path" ]; then
	if installed_output=$($install_path --version 2>&1); then
		installed_version=$(installed_product_version "$installed_output")
		if [ "$installed_output" = "$EXPECTED_VERSION_OUTPUT" ]; then
			cli_current=1
			say "$PRODUCT_NAME $PRODUCT_VERSION is already installed at $install_path"
		elif [ -n "$installed_version" ] && is_newer_version "$installed_version" "$PRODUCT_VERSION"; then
			say "$PRODUCT_NAME $installed_version is newer than $PRODUCT_VERSION; leaving it unchanged."
			exit 0
		elif [ -z "$installed_version" ] && [ "$FORCE" != "1" ]; then
			die "$install_path is not a recognized $PRODUCT_NAME install; set CHUDCODE_FORCE=1 to replace it"
		fi
	else
		[ "$FORCE" = "1" ] || die "$install_path does not start; set CHUDCODE_FORCE=1 to replace it"
	fi
fi

temp_binary=""
temp_checksum=$(mktemp "$INSTALL_DIR/.${CLI_NAME}.checksums.XXXXXX")
temp_native=""
temp_gui_archive=""
temp_gui_dir=""
temp_vision_archive=""
temp_vision_dir=""
cleanup() {
	[ -z "$temp_binary" ] || rm -f "$temp_binary"
	rm -f "$temp_checksum"
	[ -z "$temp_native" ] || rm -f "$temp_native"
	[ -z "$temp_gui_archive" ] || rm -f "$temp_gui_archive"
	[ -z "$temp_gui_dir" ] || rm -rf "$temp_gui_dir"
	[ -z "$temp_vision_archive" ] || rm -f "$temp_vision_archive"
	[ -z "$temp_vision_dir" ] || rm -rf "$temp_vision_dir"
}
trap cleanup EXIT HUP INT TERM

if ! try_fetch_asset "SHA256SUMS.txt" "$temp_checksum"; then
	if [ "$cli_current" = "1" ]; then
		create_aliases
		say "Release checksums are unavailable; existing CLI was left unchanged and optional GUI installation was skipped."
		print_path_hint
		exit 0
	fi
	die "release asset not found: SHA256SUMS.txt"
fi

if [ "$cli_current" = "0" ]; then
	say "Installing $PRODUCT_NAME $PRODUCT_VERSION for $target..."
	temp_binary=$(mktemp "$INSTALL_DIR/.${CLI_NAME}.XXXXXX")
	fetch_asset "$artifact_name" "$temp_binary"
	expected_hash=$(checksum_for "$artifact_name" "$temp_checksum") ||
		die "SHA256SUMS.txt has no entry for $artifact_name"
	[ "$(sha256_file "$temp_binary")" = "$expected_hash" ] || die "checksum mismatch for $artifact_name"
	chmod 755 "$temp_binary"
	version_output=$($temp_binary --version 2>&1) || die "downloaded binary did not start"
	[ "$version_output" = "$EXPECTED_VERSION_OUTPUT" ] || die "unexpected --version output: $version_output"

	if [ "$NATIVE_ADDON_REQUIRED" = "1" ]; then
		[ -n "$NATIVE_ADDON_ARTIFACT" ] || die "native addon is required but CHUDCODE_NATIVE_ADDON_ARTIFACT is unset"
		temp_native=$(mktemp "$INSTALL_DIR/.${CLI_NAME}.native.XXXXXX")
		fetch_asset "$NATIVE_ADDON_ARTIFACT" "$temp_native"
		native_expected_hash=$(checksum_for "$NATIVE_ADDON_ARTIFACT" "$temp_checksum") ||
			die "SHA256SUMS.txt has no entry for $NATIVE_ADDON_ARTIFACT"
		[ "$(sha256_file "$temp_native")" = "$native_expected_hash" ] ||
			die "checksum mismatch for $NATIVE_ADDON_ARTIFACT"
		chmod 755 "$temp_native"
	fi

	mv "$temp_binary" "$install_path"
	temp_binary=""
	if [ "$NATIVE_ADDON_REQUIRED" = "1" ]; then
		mv "$temp_native" "$INSTALL_DIR/$NATIVE_ADDON_ARTIFACT"
		temp_native=""
	fi
fi

create_aliases
installed_output=$($install_path --version 2>&1) || die "installed binary failed its startup check"
[ "$installed_output" = "$EXPECTED_VERSION_OUTPUT" ] || die "installed binary returned an unexpected version: $installed_output"

vision_installed=0
if [ "$target" = "linux-x64" ]; then
	temp_vision_archive=$(mktemp "$INSTALL_DIR/.${CLI_NAME}-vision.XXXXXX.tar.gz")
	if try_fetch_asset "$VISION_ARCHIVE_NAME" "$temp_vision_archive"; then
		vision_expected_hash=$(checksum_for "$VISION_ARCHIVE_NAME" "$temp_checksum") ||
			die "SHA256SUMS.txt has no entry for $VISION_ARCHIVE_NAME"
		[ "$(sha256_file "$temp_vision_archive")" = "$vision_expected_hash" ] ||
			die "checksum mismatch for $VISION_ARCHIVE_NAME"
		temp_vision_dir=$(mktemp -d "${TMPDIR:-/tmp}/chudcode-vision-install.XXXXXX")
		tar -xzf "$temp_vision_archive" -C "$temp_vision_dir"
		vision_bundle="$temp_vision_dir/${CLI_NAME}-vision-linux-x64"
		[ -x "$vision_bundle/pi-vision" ] || die "vision archive is missing pi-vision"
		[ -f "$vision_bundle/libonnxruntime.so" ] || die "vision archive is missing libonnxruntime.so"
		[ -f "$vision_bundle/ONNXRUNTIME-LICENSE" ] || die "vision archive is missing the ONNX Runtime license"
		"$vision_bundle/pi-vision" --print-manifest >/dev/null ||
			die "pi-vision failed its startup check"

		vision_install_dir="$DATA_DIR/chudcode/vision-${PRODUCT_VERSION}"
		mkdir -p "$DATA_DIR/chudcode"
		rm -rf "$vision_install_dir"
		mv "$vision_bundle" "$vision_install_dir"
		ln -sf "$vision_install_dir/pi-vision" "$INSTALL_DIR/pi-vision"
		vision_installed=1
	else
		rm -f "$temp_vision_archive"
		temp_vision_archive=""
	fi
fi


gui_installed=0
if [ "$target" = "linux-x64" ]; then
	gui_archive_name="${GUI_NAME}-${target}.tar.gz"
	temp_gui_archive=$(mktemp "$INSTALL_DIR/.${GUI_NAME}.XXXXXX.tar.gz")
	if try_fetch_asset "$gui_archive_name" "$temp_gui_archive"; then
		gui_expected_hash=$(checksum_for "$gui_archive_name" "$temp_checksum") ||
			die "SHA256SUMS.txt has no entry for $gui_archive_name"
		[ "$(sha256_file "$temp_gui_archive")" = "$gui_expected_hash" ] ||
			die "checksum mismatch for $gui_archive_name"
		temp_gui_dir=$(mktemp -d "${TMPDIR:-/tmp}/chudcode-gui-install.XXXXXX")
		tar -xzf "$temp_gui_archive" -C "$temp_gui_dir"
		gui_bundle="$temp_gui_dir/${GUI_NAME}-${target}"
		verify_gui_lock "$gui_bundle"
		[ -x "$gui_bundle/$GUI_NAME" ] || die "GUI archive is missing $GUI_NAME"
		[ -d "$gui_bundle/assets" ] || die "GUI archive is missing assets"
		[ -f "$gui_bundle/packaging/linux/chudcode.desktop" ] || die "GUI archive is missing chudcode.desktop"

		mkdir -p "$DATA_DIR/chudcode" "$DATA_DIR/applications" "$DATA_DIR/icons/hicolor"
		rm -rf "$DATA_DIR/chudcode/assets"
		cp -R "$gui_bundle/assets" "$DATA_DIR/chudcode/assets"
		cp "$gui_bundle/CHUDCODE_GUI.lock" "$DATA_DIR/chudcode/CHUDCODE_GUI.lock"
		cp "$gui_bundle/packaging/linux/chudcode.desktop" "$DATA_DIR/applications/chudcode.desktop"
		cp -R "$gui_bundle/icons/hicolor/." "$DATA_DIR/icons/hicolor/"
		cp "$gui_bundle/$GUI_NAME" "$INSTALL_DIR/$GUI_NAME"
		chmod 755 "$INSTALL_DIR/$GUI_NAME"
		if [ -e "$INSTALL_DIR/assets" ] && [ ! -L "$INSTALL_DIR/assets" ]; then
			die "$INSTALL_DIR/assets exists and is not a symlink; cannot expose GUI assets beside the executable"
		fi
		ln -sf "$DATA_DIR/chudcode/assets" "$INSTALL_DIR/assets"

		ldd_output=$(ldd "$INSTALL_DIR/$GUI_NAME" 2>&1) || die "$GUI_NAME failed its dependency check: $ldd_output"
		case "$ldd_output" in *"not found"*) die "$GUI_NAME has unresolved shared libraries: $ldd_output" ;; esac
		screenshot="$temp_gui_dir/chudcode-ui.png"
		if [ -n "${DISPLAY:-}" ]; then
			PATH="$INSTALL_DIR:${PATH:-}" "$INSTALL_DIR/$GUI_NAME" --code --ui-screenshot "$screenshot" ||
				die "$GUI_NAME screenshot verification failed"
		elif command_exists xvfb-run; then
			PATH="$INSTALL_DIR:${PATH:-}" xvfb-run -a "$INSTALL_DIR/$GUI_NAME" --code --ui-screenshot "$screenshot" ||
				die "$GUI_NAME Xvfb screenshot verification failed"
		fi
		gui_installed=1
	else
		rm -f "$temp_gui_archive"
		temp_gui_archive=""
	fi
fi

say "Installed $installed_output"
say "Commands: $CLI_NAME, $COMPAT_ALIAS, $SHORT_ALIAS, $LEGACY_ALIAS"
if [ "$gui_installed" = "1" ]; then
	say "GUI: $GUI_NAME"
else
	say "GUI artifact not present; CLI-only installation is valid."
fi
if [ "$vision_installed" = "1" ]; then
	say "Vision: pi-vision"
else
	say "Vision artifact not present; image analysis degrades with a structured install hint."
fi
print_path_hint
