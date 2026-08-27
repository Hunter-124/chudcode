# Install Chudcode

## Prerequisites

- A 64-bit Linux, macOS, or Windows environment supported by the installer.
- `gh` authenticated to the private `Hunter-124/chudcode` repository. (`curl` or `wget` can be used with an explicit release URL.)
- `sha256sum` on Linux or `shasum` on macOS.
- No root access is needed; files go under `~/.local/bin`.

The v0.1.0 release has been started and native-smoke-tested only on glibc Linux x64. The installer detects every target supported by the upstream builder, but an artifact is not published until it has started successfully on matching hardware and libc.

## Install

Run this authenticated one-liner:

```sh
gh api -H 'Accept: application/vnd.github.raw+json' 'repos/Hunter-124/chudcode/contents/install.sh?ref=v0.1.0' | sh
```

Or, from a checkout of the release tag:

```sh
./install.sh
```

The installer downloads the matching checked release asset, verifies its SHA-256 checksum and `--version` output, and creates all four CLI names:

- `chudcode` (primary)
- `chudware-code` (compatibility alias)
- `chcode` (short compatibility alias)
- `omp` (legacy compatibility alias for existing scripts)

The compiled release contains its matching native addon archive and extracts the addon to `~/.omp/natives/18.0.8/` when native functionality is first used. A `.node` file does not need to be placed beside the CLI.

When the Linux x64 GUI bundle is present in the release, the same installer also installs `chudcode-gui`, its CAD asset tree under `~/.local/share/chudcode/`, the desktop entry, and hicolor icons. A release without the optional GUI archive remains a valid CLI-only install.

If `~/.local/bin` is not already on `PATH`, follow the command printed by the installer, then open a new shell.

## Verify

```sh
chudcode --version
chudware-code --version
chcode --version
omp --version
```

All four should print:

```text
Chudcode v0.1.0 (based on omp 18.0.8)
```

## Update

Re-run the install command. Installing the same version is an idempotent no-op apart from repairing the aliases. An older Chudcode install is replaced after the downloaded artifact passes verification. A newer install is reported and left untouched.

## Uninstall

```sh
rm -f ~/.local/bin/chudcode ~/.local/bin/chudware-code ~/.local/bin/chcode ~/.local/bin/omp
rm -f ~/.local/bin/chudcode-gui ~/.local/bin/assets
rm -f ~/.local/share/applications/chudcode.desktop
rm -rf ~/.local/share/chudcode
find ~/.local/share/icons/hicolor -path '*/apps/chudcode.png' -delete
```

This deliberately leaves configuration, credentials, profiles, session history, and extracted native files in `~/.omp`. Remove that directory separately only if you intend to erase all local Chudcode state.

## GUI status

`chudcode-gui` is the actual CAD/Chudware copilot Code workspace, connected to the Chudcode CLI over ACP; it is not a fixture or a separate reimplementation. In v0.1.0 it supports the live conversation path but does not yet expose rename, delete, pin, artifact enumeration, or jobs.
