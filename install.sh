#!/bin/sh
set -eu

PRODUCT_NAME="Chudcode"
PRODUCT_VERSION="0.1.0"
UPSTREAM_VERSION="18.0.8"
CLI_NAME="chudcode"
COMPAT_ALIAS="chudware-code"
SHORT_ALIAS="chcode"
LEGACY_ALIAS="omp"
RELEASE_TAG="v${PRODUCT_VERSION}"
RELEASE_REPOSITORY="Hunter-124/chudcode"
EXPECTED_VERSION_OUTPUT="${CHUDCODE_EXPECTED_VERSION_OUTPUT:-${PRODUCT_NAME} v${PRODUCT_VERSION} (based on ${LEGACY_ALIAS} ${UPSTREAM_VERSION})}"
INSTALL_DIR="${CHUDCODE_INSTALL_DIR:-${HOME}/.local/bin}"
ARTIFACT_DIR="${CHUDCODE_ARTIFACT_DIR:-}"
RELEASE_BASE_URL="${CHUDCODE_RELEASE_BASE_URL:-}"
NATIVE_ADDON_REQUIRED="${CHUDCODE_NATIVE_ADDON_REQUIRED:-0}"
NATIVE_ADDON_ARTIFACT="${CHUDCODE_NATIVE_ADDON_ARTIFACT:-}"
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

fetch_asset() {
	asset=$1
	destination=$2
	if [ -n "$ARTIFACT_DIR" ]; then
		[ -f "$ARTIFACT_DIR/$asset" ] || die "release asset not found: $ARTIFACT_DIR/$asset"
		cp "$ARTIFACT_DIR/$asset" "$destination"
	elif [ -n "$RELEASE_BASE_URL" ]; then
		download_url "${RELEASE_BASE_URL%/}/$asset" "$destination"
	elif command_exists gh; then
		gh release download "$RELEASE_TAG" --repo "$RELEASE_REPOSITORY" --pattern "$asset" --output "$destination"
	else
		download_url "https://github.com/${RELEASE_REPOSITORY}/releases/download/${RELEASE_TAG}/$asset" "$destination"
	fi
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

if [ -e "$install_path" ] || [ -L "$install_path" ]; then
	if installed_output=$($install_path --version 2>&1); then
		installed_version=$(installed_product_version "$installed_output")
		if [ "$installed_output" = "$EXPECTED_VERSION_OUTPUT" ]; then
			create_aliases
			say "$PRODUCT_NAME $PRODUCT_VERSION is already installed at $install_path"
			print_path_hint
			exit 0
		fi
		if [ -n "$installed_version" ] && is_newer_version "$installed_version" "$PRODUCT_VERSION"; then
			say "$PRODUCT_NAME $installed_version is newer than $PRODUCT_VERSION; leaving it unchanged."
			exit 0
		fi
		if [ -z "$installed_version" ] && [ "$FORCE" != "1" ]; then
			die "$install_path is not a recognized $PRODUCT_NAME install; set CHUDCODE_FORCE=1 to replace it"
		fi
	else
		[ "$FORCE" = "1" ] || die "$install_path does not start; set CHUDCODE_FORCE=1 to replace it"
	fi
fi

temp_binary=$(mktemp "$INSTALL_DIR/.${CLI_NAME}.XXXXXX")
temp_checksum=$(mktemp "$INSTALL_DIR/.${CLI_NAME}.checksums.XXXXXX")
temp_native=""
cleanup() {
	rm -f "$temp_binary" "$temp_checksum"
	[ -z "$temp_native" ] || rm -f "$temp_native"
}
trap cleanup EXIT HUP INT TERM

say "Installing $PRODUCT_NAME $PRODUCT_VERSION for $target..."
fetch_asset "$artifact_name" "$temp_binary"
fetch_asset "SHA256SUMS.txt" "$temp_checksum"

expected_hash=""
while read -r checksum filename; do
	if [ "$filename" = "$artifact_name" ]; then
		expected_hash=$checksum
		break
	fi
done < "$temp_checksum"
[ -n "$expected_hash" ] || die "SHA256SUMS.txt has no entry for $artifact_name"

if command_exists sha256sum; then
	actual_hash=$(sha256sum "$temp_binary")
	actual_hash=${actual_hash%% *}
elif command_exists shasum; then
	actual_hash=$(shasum -a 256 "$temp_binary")
	actual_hash=${actual_hash%% *}
else
	die "sha256sum or shasum is required to verify the release artifact"
fi
[ "$actual_hash" = "$expected_hash" ] || die "checksum mismatch for $artifact_name"

chmod 755 "$temp_binary"
version_output=$($temp_binary --version 2>&1) || die "downloaded binary did not start"
[ "$version_output" = "$EXPECTED_VERSION_OUTPUT" ] || die "unexpected --version output: $version_output"

if [ "$NATIVE_ADDON_REQUIRED" = "1" ]; then
	[ -n "$NATIVE_ADDON_ARTIFACT" ] || die "native addon is required but CHUDCODE_NATIVE_ADDON_ARTIFACT is unset"
	temp_native=$(mktemp "$INSTALL_DIR/.${CLI_NAME}.native.XXXXXX")
	fetch_asset "$NATIVE_ADDON_ARTIFACT" "$temp_native"
	native_expected_hash=""
	while read -r checksum filename; do
		if [ "$filename" = "$NATIVE_ADDON_ARTIFACT" ]; then
			native_expected_hash=$checksum
			break
		fi
	done < "$temp_checksum"
	[ -n "$native_expected_hash" ] || die "SHA256SUMS.txt has no entry for $NATIVE_ADDON_ARTIFACT"
	if command_exists sha256sum; then
		native_actual_hash=$(sha256sum "$temp_native")
		native_actual_hash=${native_actual_hash%% *}
	else
		native_actual_hash=$(shasum -a 256 "$temp_native")
		native_actual_hash=${native_actual_hash%% *}
	fi
	[ "$native_actual_hash" = "$native_expected_hash" ] || die "checksum mismatch for $NATIVE_ADDON_ARTIFACT"
	chmod 755 "$temp_native"
fi

mv "$temp_binary" "$install_path"
if [ "$NATIVE_ADDON_REQUIRED" = "1" ]; then
	mv "$temp_native" "$INSTALL_DIR/$NATIVE_ADDON_ARTIFACT"
	temp_native=""
fi

create_aliases
installed_output=$($install_path --version 2>&1) || die "installed binary failed its startup check"
[ "$installed_output" = "$EXPECTED_VERSION_OUTPUT" ] || die "installed binary returned an unexpected version: $installed_output"

say "Installed $installed_output"
say "Commands: $CLI_NAME, $COMPAT_ALIAS, $SHORT_ALIAS, $LEGACY_ALIAS"
print_path_hint
