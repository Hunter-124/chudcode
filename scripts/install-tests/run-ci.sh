#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"
host_tag="$(bun -e 'process.stdout.write(`${process.platform}-${process.arch}`)')"
WORK_DIR="$(mktemp -d)"
TMP_WORK_DIR="$WORK_DIR/tmp"
mkdir -p "$TMP_WORK_DIR"
export TMPDIR="$TMP_WORK_DIR"

NATIVES_PACKAGE="$ROOT_DIR/packages/natives/package.json"
NATIVES_PACKAGE_INITIAL="$WORK_DIR/natives-package.initial.json"
cp "$NATIVES_PACKAGE" "$NATIVES_PACKAGE_INITIAL"
restore_workspace() {
   cp "$NATIVES_PACKAGE_INITIAL" "$NATIVES_PACKAGE"
   rm -rf "$WORK_DIR"
}
trap restore_workspace EXIT

section() {
   echo ""
   echo "=== $1 ==="
}

smoke_cli() {
   local chudcode_bin="$1"
   local runtime_dir
   runtime_dir="$(mktemp -d "$WORK_DIR/compiled-runtime.XXXXXX")"
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$chudcode_bin" --version
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$chudcode_bin" --help >/dev/null
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$chudcode_bin" stats --summary >/dev/null
   # Spawns bundled workers and serves the stats dashboard once. Regression
   # probe for #1011/#1027 worker loading and for npm/compiled distributions
   # missing the dashboard assets that `stats --summary` never touches.
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$chudcode_bin" --smoke-test
}

find_tarball() {
   local manifest="$ROOT_DIR/$1/package.json"
   local name version archive
   name="$(jq -er '.name' "$manifest")"
   version="$(jq -er '.version' "$manifest")"
   # Bun names a scoped pack @scope/name as scope-name-version.tgz.
   name="${name#@}"
   archive="$TARBALL_DIR/${name//\//-}-$version.tgz"

   if [ ! -f "$archive" ]; then
      echo "Missing packed tarball for $1: $archive" >&2
      exit 1
   fi

   printf '%s\n' "$archive"
}

align_native_manifest() {
   local addon_version=""
   local addon
   local candidate_version
   local candidates=()
   shopt -s nullglob
   candidates=("$ROOT_DIR"/packages/natives/native/chud_natives."$host_tag"-*.node)
   shopt -u nullglob

   if [ "${#candidates[@]}" -eq 0 ]; then
      echo "No native addon found for install smoke" >&2
      exit 1
   fi
   for addon in "${candidates[@]}"; do
      candidate_version="$(bun "$ROOT_DIR/scripts/install-tests/native-version.ts" "$addon")" || exit 1
      if [ -z "$addon_version" ]; then
         addon_version="$candidate_version"
      elif [ "$addon_version" != "$candidate_version" ]; then
         echo "Native addon version mismatch: $addon_version vs $candidate_version ($addon)" >&2
         exit 1
      fi
   done

   local declared_version
   declared_version="$(jq -r '.version' "$NATIVES_PACKAGE")"
   if [ "$declared_version" = "$addon_version" ]; then return; fi

   echo "Aligning install smoke native manifest $declared_version → $addon_version"
   jq --arg version "$addon_version" '.version = $version' "$NATIVES_PACKAGE" > "$WORK_DIR/natives-package.aligned.json"
   mv "$WORK_DIR/natives-package.aligned.json" "$NATIVES_PACKAGE"
}
section "Binary install smoke"
if [ "${CHUDCODE_INSTALL_TEST_SKIP_NATIVE_BUILD:-0}" != "1" ]; then
   bun --cwd=packages/natives run build
fi
align_native_manifest
bun --cwd=packages/coding-agent run build

BINARY_DIR="$WORK_DIR/binary-bin"
mkdir -p "$BINARY_DIR"
cp packages/coding-agent/dist/chudcode "$BINARY_DIR/chudcode"
smoke_cli "$BINARY_DIR/chudcode"

section "Source install smoke"
SOURCE_BUN_HOME="$WORK_DIR/bun-source"
(
   export BUN_INSTALL="$SOURCE_BUN_HOME"
   export PATH="$BUN_INSTALL/bin:$PATH"
   bun --cwd="$ROOT_DIR/packages/coding-agent" link
   smoke_cli "$BUN_INSTALL/bin/chudcode"
)

section "Tarball install smoke"
TARBALL_DIR="$WORK_DIR/tarballs"
mkdir -p "$TARBALL_DIR"

# Native addon split: the published core ships only the loader (no `.node`); the
# prebuilt binary lives in a per-platform leaf package pulled in as an optional
# dependency. Reproduce that exact published topology so this smoke proves the
# installed core resolves its addon through the leaf, not a bundled binary.

# 1. Generate + pack the host-platform leaf (carries the built `.node`).
bun --cwd=packages/natives run gen:npm --tag "$host_tag" >/dev/null
(
   cd "$ROOT_DIR/packages/natives/npm/$host_tag"
   bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null
)

# 2. Pack the core with its *published* manifest: the same rewrite release uses
#    drops `.node` from `files` and adds the leaf `optionalDependencies`. Always
#    restore the working-tree manifest so local runs aren't left mutated.
natives_pkg_backup="$WORK_DIR/natives-package.json.orig"
cp "$ROOT_DIR/packages/natives/package.json" "$natives_pkg_backup"
core_rc=0
{
   bun -e 'import { prepareNativeCorePackage } from "./scripts/ci-release-publish.ts"; await prepareNativeCorePackage("packages/natives", true);' &&
      (cd "$ROOT_DIR/packages/natives" && bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null)
} || core_rc=$?
cp "$natives_pkg_backup" "$ROOT_DIR/packages/natives/package.json"
[ "$core_rc" -eq 0 ] || exit "$core_rc"

# 3. Pack the remaining workspace packages (natives core and coding-agent
#    handled separately). `collab-web` is private but still packed here so its
#    prepack build and tarball file list stay release-safe.
for pkg in utils wire chudtype hashline catalog ai mnemo snapcompact agent tui stats collab-web; do
   (
      cd "$ROOT_DIR/packages/$pkg"
      bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null
   )
done

# 4. Pack the coding agent with its *published* manifest: release swaps
#    `bin.chudcode` from `src/cli.ts` to the prepack bundle `dist/cli.js`. The repo
#    manifest keeps pointing at source so `bun link`/`install.sh --source`
#    work without a build, so the swap must be reproduced here for the smoke
#    to exercise the bundled worker-host entry the published package ships.
#    Always restore the working-tree manifest.
agent_pkg_backup="$WORK_DIR/coding-agent-package.json.orig"
cp "$ROOT_DIR/packages/coding-agent/package.json" "$agent_pkg_backup"
agent_rc=0
{
   bun -e 'import { applyPublishBin } from "./scripts/ci-release-publish.ts"; await applyPublishBin("packages/coding-agent", true);' &&
      (cd "$ROOT_DIR/packages/coding-agent" && bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null)
} || agent_rc=$?
cp "$agent_pkg_backup" "$ROOT_DIR/packages/coding-agent/package.json"
[ "$agent_rc" -eq 0 ] || exit "$agent_rc"

utils_tgz="$(find_tarball packages/utils)"
wire_tgz="$(find_tarball packages/wire)"
omptype_tgz="$(find_tarball packages/chudtype)"
natives_tgz="$(find_tarball packages/natives)"
natives_leaf_tgz="$(find_tarball "packages/natives/npm/$host_tag")"
hashline_tgz="$(find_tarball packages/hashline)"
catalog_tgz="$(find_tarball packages/catalog)"
ai_tgz="$(find_tarball packages/ai)"
mnemopi_tgz="$(find_tarball packages/mnemo)"
snapcompact_tgz="$(find_tarball packages/snapcompact)"
agent_tgz="$(find_tarball packages/agent)"
tui_tgz="$(find_tarball packages/tui)"
stats_tgz="$(find_tarball packages/stats)"
coding_agent_tgz="$(find_tarball packages/coding-agent)"
collab_web_tgz="$(find_tarball packages/collab-web)"

TARBALL_APP_DIR="$WORK_DIR/tarball-install"
mkdir -p "$TARBALL_APP_DIR"
(
   cd "$TARBALL_APP_DIR"
   bun init -y >/dev/null

   # Write overrides so bun resolves inter-package deps from tarballs, not the registry
   # (the version under test has not necessarily been published yet).
   node -e "
		const pkg = JSON.parse(require('fs').readFileSync('package.json', 'utf8'));
		pkg.overrides = {
			'@chudware/utils': '$utils_tgz',
			'@chudware/wire': '$wire_tgz',
			'@chudware/chudtype': '$omptype_tgz',
			'@chudware/natives': '$natives_tgz',
			'@chudware/natives-$host_tag': '$natives_leaf_tgz',
			'@chudware/hashline': '$hashline_tgz',
			'@chudware/ai': '$ai_tgz',
			'@chudware/catalog': '$catalog_tgz',
			'@chudware/mnemo': '$mnemopi_tgz',
			'@chudware/snapcompact': '$snapcompact_tgz',
			'@chudware/agent-core': '$agent_tgz',
			'@chudware/tui': '$tui_tgz',
			'@chudware/stats': '$stats_tgz',
			'@chudware/coding-agent': '$coding_agent_tgz',
			'@chudware/collab-web': '$collab_web_tgz'
		};
		require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));
	"

   bun add "$utils_tgz" "$wire_tgz" "$omptype_tgz" "$natives_tgz" "$hashline_tgz" "$catalog_tgz" "$ai_tgz" "$mnemopi_tgz" "$snapcompact_tgz" "$agent_tgz" "$tui_tgz" "$stats_tgz" "$coding_agent_tgz" "$collab_web_tgz"
   # The platform leaf must arrive through the core's optionalDependencies +
   # override, not as a direct dependency — assert it landed before smoking so a
   # resolution regression is distinguishable from a runtime loader bug.
   leaf_dir="node_modules/@chudware/natives-$host_tag"
   [ -d "$leaf_dir" ] || {
      echo "Platform leaf package not installed: $leaf_dir"
      exit 1
   }
   wire_proto="$(bun -e 'import { COLLAB_PROTO } from "@chudware/wire"; process.stdout.write(String(COLLAB_PROTO));')"
   [ "$wire_proto" = "3" ] || {
      echo "Unexpected @chudware/wire COLLAB_PROTO: $wire_proto"
      exit 1
   }
   omptype_probe="$(bun -e '
      import { type } from "@chudware/chudtype";
      import { Type } from "@chudware/chudtype/typebox";
      const root = type({ name: "string", enabled: "boolean = false" }).assert({ name: "chudcode" });
      const typebox = Type.Object({ name: Type.String() }).assert({ name: "tb" });
      process.stdout.write(`${root.name}:${root.enabled}:${typebox.name}`);
   ')"
   [ "$omptype_probe" = "chudcode:false:tb" ] || {
      echo "Unexpected @chudware/chudtype probe result: $omptype_probe"
      exit 1
   }
   [ -f "node_modules/@chudware/collab-web/dist/index.html" ] || {
      echo "Collab web tarball did not install built dist/index.html"
      exit 1
   }
   smoke_cli ./node_modules/.bin/chudcode
)

echo ""
echo "All install method smoke tests passed"
