#!/bin/sh
# Install the upstream dev wrapper as `chud` in Bun's global bin directory.
# The wrapper protects launches from project-local Bun preloads while restoring cwd.
#
# We resolve Bun's global bin path defensively because `bun pm -g bin` aborts
# (`No package.json was found for directory "$HOME/.bun/install/global"`) on
# fresh hosts where the global install has not been initialized. Avoid
# resolving the missing global bin path to the filesystem root.
set -e

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
target=$repo_root/packages/coding-agent/scripts/omp

if [ ! -x "$target" ]; then
	echo "link-chudcode: target wrapper not found or not executable: $target" >&2
	exit 1
fi

global_bin=$(bun pm -g bin 2>/dev/null || true)
if [ -z "$global_bin" ]; then
	global_bin=${BUN_INSTALL:-$HOME/.bun}/bin
fi

mkdir -p "$global_bin"
ln -sfn "$target" "$global_bin/chud"
echo "link-chudcode: linked $global_bin/chud -> $target"
