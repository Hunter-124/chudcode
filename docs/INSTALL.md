# Install Chudcode

Chudcode desktop releases are standalone, source-checkout-free archives. They do
not require Bun, `node_modules`, a repository checkout, or a runtime download.
Each archive contains adjacent compiled `chud`, `chudcode-desktop`, and
`chudcode-gui` executables plus the web/native GUI assets, fonts, icons,
`VERSION`, `NOTICE`, and `THIRD-PARTY-NOTICES.txt`.

## Supported release artifacts

| Operating system | Architecture | Asset |
| --- | --- | --- |
| Linux | x86-64 | `chudcode-desktop-linux-x64.tar.gz` |
| macOS | Intel x86-64 | `chudcode-desktop-macos-x64.tar.gz` |
| Windows (Git Bash/MSYS2) | x86-64 | `chudcode-desktop-windows-x64.zip` |

A release is incomplete unless all three supported assets are present. The release root also
contains `SHA256SUMS.txt` and `release-manifest.json`. The manifest records the
product version, RPC and desktop protocol versions, target/architecture, size,
and SHA-256 hash for each canonical archive.

## Install

Download the installer from source revision
`8f70d216879be0cfe6bfeb5520f2370521224330`, inspect it, then install the
**0.4.4** release. `install.sh` is a source file, not a release asset.
These HTTPS commands do not use `gh` or require a GitHub token:

```sh
installer_dir=$(mktemp -d)
curl -q -fsSL \
  https://raw.githubusercontent.com/Hunter-124/chudcode/8f70d216879be0cfe6bfeb5520f2370521224330/install.sh \
  -o "$installer_dir/install.sh"
# Inspect "$installer_dir/install.sh" before running it.
CHUDCODE_RELEASE_BASE_URL=https://github.com/Hunter-124/chudcode/releases/download/chudcode-v0.4.4 \
  sh "$installer_dir/install.sh"
```

The explicit release base URL selects HTTPS downloads instead of `gh`. A POSIX
shell, `curl` or `wget`, and archive extraction tools are required. Linux and
macOS need `sha256sum` or `shasum`; Windows (Git Bash/MSYS2) needs `unzip`.

The installer detects the operating system and architecture, chooses exactly one
canonical archive, and fails closed unless all of these agree:

1. `release-manifest.json` has the expected Chudcode and protocol versions.
2. The manifest and selected archive match their `SHA256SUMS.txt` entries.
3. The selected archive hash also matches its manifest record.
4. The archive name, manifest target, and detected host OS/architecture agree.
5. The archive is path-safe and contains no checkout, `node_modules`, TypeScript,
   source tree, Bun lockfile, or package manifest.
6. `VERSION`, the `chud` and `chudcode-desktop` version results, required assets,
   and legal notices agree with the installer version.

macOS and Windows release jobs additionally validate their native platform code
signatures before publication. Hash or manifest mismatches, CLI or desktop-server
startup failures, missing or incomplete notices, and source-bearing payloads abort
before installation changes.

The default locations are:

- immutable payload: `~/.local/share/chudcode/releases/<version>-<target>/`
- atomic active link: `~/.local/share/chudcode/current`
- command links: `~/.local/bin/`

Set `CHUDCODE_INSTALL_ROOT`, `CHUDCODE_DATA_DIR`, or `CHUDCODE_INSTALL_DIR` to
change these. Activation swaps one `current` symlink only after the staged copy
passes its checks. A failed download, validation, staging, or activation restores
the previous active release. Repeating the same install is safe; different
same-version contents are refused unless `CHUDCODE_FORCE=1` is explicit.

The standalone installer never writes into Chudware's embedded runtime. A path
marked with `.chudware-private-runtime`, or a Chudware private/embedded runtime
path, is refused even when force mode is enabled.

## CLI-only installation

The desktop archive always carries the complete, verified payload, but command
exposure can remain CLI-only:

```sh
CHUDCODE_RELEASE_BASE_URL=https://github.com/Hunter-124/chudcode/releases/download/chudcode-v0.4.4 \
  CHUDCODE_INSTALL_DESKTOP=0 sh "$installer_dir/install.sh"
```

This installs/exposes `chud` and its `chudcode` compatibility alias without
adding `chudcode-desktop` or `chudcode-gui` command links. Set the value back to
`1` on a later run to expose the desktop commands.

## Offline installation

Put the selected archive, `SHA256SUMS.txt`, and `release-manifest.json` in one
trusted directory, then run:

```sh
CHUDCODE_ARTIFACT_DIR=/media/chudcode-release sh ./install.sh
```

Offline mode performs the same manifest, hash, target, version, notice,
source-free, and executable startup checks. It never installs dependencies from
the network.

## Manual verification

From a directory containing a complete release:

```sh
sha256sum -c SHA256SUMS.txt       # Linux
shasum -a 256 -c SHA256SUMS.txt  # macOS
```

Then inspect `release-manifest.json` and the archive's `VERSION`, `NOTICE`, and
`THIRD-PARTY-NOTICES.txt`. Do not install a release whose three-target set or
metadata is incomplete.

## Build from source and embed

For the pinned source checkout, native prerequisites, addon build and compiled
CLI commands, see [Development](../README.md#development). The compiled source
CLI is `packages/coding-agent/dist/omp`, not `dist/chud`.
The [Python SDK installation guide](../python/chudcode-rpc/README.md#installation)
covers Python ≥3.11 and a provider-free RPC smoke command; installing the SDK
does not install the runtime.
