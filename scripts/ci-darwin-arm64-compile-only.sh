#!/bin/bash
# darwin-arm64 COMPILE-ONLY proof on a native Intel Mac.
#
#   scripts/ci-darwin-arm64-compile-only.sh <work-dir>
#
# Cross-compiles, with the host Xcode SDK and the repository's pinned Bazel
# Rust toolchain, the shipped //:natives-darwin-arm64 addon, every Rust test
# binary under //crates/... and the native GUI plus its headless test
# executables, then proves each output is a thin arm64 Mach-O. Nothing built
# here is executed: an Intel Mac cannot run arm64 code. This is not native
# Apple silicon runtime evidence, and none of these outputs is a release,
# signing or notarisation input.
#
# The whole run, every child included, has a hard 75 min budget: the script
# re-executes itself under scripts/ci-deadline.ts, which owns a process group
# for it, sends SIGTERM then SIGKILL after 15 s, and exits 124 on expiry. The
# workflow job's 90 min cap leaves 15 min for checkout, tool setup and cleanup.
# The cold Intel 2013 Mac run #37235691367 was still building the addon at
# action 2475/3233 when its old 50 min deadline expired with one compiler
# worker. That run never reached Rust tests or the GUI; 75 min is the bounded
# qualification budget for the complete work, not measured completion proof.
#
# Optional environment: OMP_BAZEL_RC (rc fragment from
# .github/actions/bazel-cache), CMAKE_BUILD_PARALLEL_LEVEL.
set -euo pipefail

readonly BUDGET_SECONDS=4500

fail() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

[ "$#" -eq 1 ] || fail "usage: $0 <work-dir>"
[ "$(uname -s)" = Darwin ] || fail "darwin-arm64 cross-compilation needs the macOS SDK"
[ "$(uname -m)" = x86_64 ] || fail "this lane is the Intel Mac compile-only proof; this host is $(uname -m)"
# sysctl.proc_translated is 1 under Rosetta and absent on Intel hardware.
[ "$(sysctl -in sysctl.proc_translated || true)" != 1 ] || fail "refusing to run under Rosetta translation"

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
if [ -z "${CHUDCODE_CI_DEADLINE_SECONDS:-}" ]; then
	command -v bun >/dev/null || fail "bun is required"
	exec bun "$repo_root/scripts/ci-deadline.ts" "$BUDGET_SECONDS" -- \
		bash "$repo_root/scripts/ci-darwin-arm64-compile-only.sh" "$@"
fi
case "$1" in
	/*) work=$1 ;;
	*) work="$PWD/$1" ;;
esac
mkdir -p "$work"
cd "$repo_root"

bazel=(bazelisk)
[ -n "${OMP_BAZEL_RC:-}" ] && bazel+=("--bazelrc=$OMP_BAZEL_RC")

checked=0
require_arm64() {
	local archs
	archs=$(lipo -archs "$1") || fail "$1 is not a Mach-O file"
	[ "$archs" = arm64 ] || fail "$1 contains architecture(s) '$archs', expected exactly arm64"
	printf 'arm64 Mach-O (compile-only, not executed): %s\n' "${1#"$work"/}"
	checked=$((checked + 1))
}

# 1. Shipped addon, through the same driver and transition as release builds.
#    bazel-natives.ts never probes it: darwin-arm64 is not this host's target.
#    Both Rust phases use the same compile-only config: matching the shipping
#    transition's release profile and cross-test define lets Bazel reuse
#    common dependency actions instead of rebuilding them in fastbuild.
bun scripts/bazel-natives.ts darwin-arm64 --dest "$work/natives" -- \
	--config=darwin-arm64-compile-only
require_arm64 "$work/natives/pi_natives.darwin-arm64.node"

# 2. Every Rust crate and test binary for aarch64-apple-darwin.
"${bazel[@]}" build --config=darwin-arm64-compile-only //crates/...
execroot=$("${bazel[@]}" info --config=darwin-arm64-compile-only execution_root)
"${bazel[@]}" cquery --config=darwin-arm64-compile-only 'kind("rust_test", //crates/...)' --output=files >"$work/rust-tests.txt"
tests=()
while IFS= read -r output; do
	tests+=("$output")
done <"$work/rust-tests.txt"
[ "${#tests[@]}" -gt 0 ] || fail "no darwin-arm64 rust_test outputs were configured"
for output in "${tests[@]}"; do
	require_arm64 "$execroot/$output"
done

# 3. Native GUI and its headless test executables (the same set the native
#    macOS gate runs), cross-compiled for arm64 and not run.
gui_build="$work/gui"
cmake -S gui -B "$gui_build" -G Ninja \
	-DCMAKE_BUILD_TYPE=Release \
	-DCMAKE_OSX_ARCHITECTURES=arm64 \
	-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
	-DBUILD_TESTING=ON
cmake --build "$gui_build" --parallel "${CMAKE_BUILD_PARALLEL_LEVEL:-$(sysctl -n hw.logicalcpu)}"
require_arm64 "$gui_build/chudcode-gui"
gui_tests=("$gui_build"/test_*)
[ -e "${gui_tests[0]}" ] || fail "GUI build produced no test executables"
for binary in "${gui_tests[@]}"; do
	require_arm64 "$binary"
done

printf 'darwin-arm64 compile-only proof: %d arm64 Mach-O outputs built on %s (%s); none executed\n' \
	"$checked" "$(uname -m)" "$(sysctl -n machdep.cpu.brand_string)"
