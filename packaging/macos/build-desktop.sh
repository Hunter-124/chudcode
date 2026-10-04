#!/bin/sh
set -eu

case "${1:-}" in
	macos-x64)
		expected_host=x86_64
		cmake_arch=x86_64
		;;
	macos-arm64)
		expected_host=arm64
		cmake_arch=arm64
		;;
	*)
		printf 'usage: %s <macos-x64|macos-arm64> <build-dir>\n' "$0" >&2
		exit 2
		;;
esac

[ "$#" -eq 2 ] || {
	printf 'usage: %s <macos-x64|macos-arm64> <build-dir>\n' "$0" >&2
	exit 2
}

target=$1
build_dir=$2
host_arch=$(uname -m)
[ "$host_arch" = "$expected_host" ] || {
	printf 'error: target %s requires a native %s runner; this runner is %s; refusing to cross-label a binary\n' \
		"$target" "$expected_host" "$host_arch" >&2
	exit 1
}

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
case "$build_dir" in
	/*) ;;
	*) build_dir="$repo_root/$build_dir" ;;
esac

cmake -S "$repo_root/gui" -B "$build_dir" -G Ninja \
	-DCMAKE_BUILD_TYPE=Release \
	-DCMAKE_OSX_ARCHITECTURES="$cmake_arch" \
	-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
	-DBUILD_TESTING=ON
cmake --build "$build_dir" --parallel "${CMAKE_BUILD_PARALLEL_LEVEL:-$(sysctl -n hw.logicalcpu)}"

# app_ini requires a live window server. All headless native test executables run
# on both macOS architectures; the launch test is covered by Linux/Xvfb.
ctest --test-dir "$build_dir" --output-on-failure -E '^app_ini$'

gui="$build_dir/chudcode-gui"
[ -x "$gui" ] || {
	printf 'error: native GUI build did not produce %s\n' "$gui" >&2
	exit 1
}

actual_archs=$(lipo -archs "$gui")
[ "$actual_archs" = "$cmake_arch" ] || {
	printf 'error: %s contains architecture(s) %s; expected exactly %s\n' \
		"$gui" "$actual_archs" "$cmake_arch" >&2
	exit 1
}

printf '%s\n' "$gui"
