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

Download `install.sh` from the same release, inspect it, then run it:

```sh
gh api \
  -H 'Accept: application/vnd.github.raw+json' \
  /repos/Hunter-124/chudcode/contents/install.sh?ref=chudcode-v0.2.0 \
  > /tmp/chudcode-install.sh
sh /tmp/chudcode-install.sh
```

Without `gh`, set `CHUDCODE_RELEASE_BASE_URL` to an authenticated or public
release-asset URL and run the script. `curl` or `wget` is required. Linux and
macOS need `sha256sum` or `shasum`; Windows archive extraction needs `unzip`.

The installer detects the operating system and architecture, chooses exactly one
canonical archive, and fails closed unless all of these agree:

1. `release-manifest.json` has the expected Chudcode and protocol versions.
2. `SHA256SUMS.txt` authenticates the manifest and selected archive hashes.
3. The selected archive hash also matches its manifest record.
4. The archive name, manifest target, and detected host OS/architecture agree.
5. The archive is path-safe and contains no checkout, `node_modules`, TypeScript,
   source tree, Bun lockfile, or package manifest.
6. `VERSION`, all three executable `--version` results, required assets, and the
   legal notices agree with the installer version.

macOS and Windows release jobs additionally validate their native platform code
signatures before publication. Hash and manifest mismatches, a wrong binary
architecture (which cannot pass the native startup check), missing or incomplete
notices, and source-bearing payloads abort before installation changes.

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
CHUDCODE_INSTALL_DESKTOP=0 sh /tmp/chudcode-install.sh
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
