# Chudcode

Chudcode (`chud`) is a private fork of OMP built for the Chudware CAD agent
integration. It also ships a standalone CLI and desktop runtime. Upstream
packages and environment variable names remain those of OMP.
See [`docs/rpc.md`](docs/rpc.md) for the protocol and
[`packages/coding-agent/DEVELOPMENT.md`](packages/coding-agent/DEVELOPMENT.md)
for the source layout.

## Development

From the repository root:

```sh
bun install --frozen-lockfile
bun --cwd packages/coding-agent run check
bun --cwd packages/coding-agent run test
bun --cwd packages/coding-agent run build
```

These commands are documented in [`packages/coding-agent/DEVELOPMENT.md`](packages/coding-agent/DEVELOPMENT.md). Other packages have their own development and test commands. Local user state lives in `~/.chudcode` (or XDG `chudcode` directories); agent and package overrides retain the upstream `PI_CODING_AGENT_DIR` and `PI_PACKAGE_DIR` names.

### Isolated CI runners

Linux CI uses `cc-linux-chudcode`: the `Chudcode-CI` utility VM on
GarrisonGamingPC, owned by the batch-only `ChudcodeLinuxCI` Windows account.
Its ext4 root, runner work, Bun/Bazel caches and temporary/container state are
backed by `D:\ChudcodeCI\Linux` on the 4 TB NVMe. It does not share a kernel,
network namespace, home or cleanup scope with CloudCastle or Chudware.

Native Windows CI uses `cc-win-chudcode`, runner `chudcode-ryzen-windows`.
Its non-administrator virtual service account owns
`D:\ChudcodeCI\Windows`, including its profile, work, tool caches and temporary
files. Read-only Visual Studio SDKs may be shared; Chudware's private Python,
CMake, Cargo or Bun locations must never be borrowed.

Native Intel Mac CI uses `cc-mac-chudcode-intel`, hidden account
`ccci-chudcode` with a private 0700 home and runner under
`/Library/CloudCastleCI/ccci-chudcode`. It owns its Bun/Bazel/XDG state and
temporary files, cannot write other products' homes or the operator's
Homebrew installation, and receives no signing keychain or desktop session.
On the 8 GB Intel Mac, each product compiles with one worker and runs CTest
serially.

Dispatch `runner-smoke` for a specific native platform before promoting a
new runner. It verifies the actual private account/state and compiles, links
and executes the existing native desktop gate. Linux exercises `app_ini`
under Xvfb; the existing Windows and Mac headless gates exclude that
interactive-window test. Windows bootstrap qualification uses only
`chudcode-bootstrap`; Mac uses `cc-mac-chudcode-intel-bootstrap`.
Production labels are added after qualification. Retire old shared-account
workstation/laptop runners only after replacement consumer proof. Existing
native signing identities are not test-account credentials.


## Fork layer

Since 0.4.0 Chudcode is a thin layer on upstream `can1357/oh-my-pi` (remote `upstream`): upstream's tree is the base, and only the changes below diverge. The 18.0.8-based fork with its package/crate renames and TUI reworks is preserved at tag `archive/chudcode-fork-18.0.8`.

- Identity: `packages/coding-agent/src/brand.ts`, `packages/utils/src/dirs.ts`, help text interpolating the identity constants, the GitHub-release updater, `install.sh`.
- CAD RPC contract: host-tool inheritance with `agentId`/`parentAgentId`, `--no-mcp` and the inherited `--tools` ceiling, auth/memory/STT commands, `/session doctor`, the sharpshooter session-model fallback, and `python/chudcode-rpc`.
- Additions: `image_analyze` (`crates/chud-vision`), `cpp_static`/`cpp_runtime`/`binary_inspect`/`firmware`, editor redo, the Windows keybinding preset, keyword modes, `/cache`, `history://<id>/images`, `xd://` line selectors.
- Fork-only trees: `gui/`, `packages/chudcode-desktop`, `packages/cloudcastle-*`, `packaging/`, release scripts and `.github/`.

To sync, `git fetch upstream && git merge upstream/main`; conflicts are confined to the files above. Keep new fork changes in fork-only files with small hooks into upstream code.

## Attribution

This codebase is based on [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), itself a fork of [badlogic's pi](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/mariozechner). It is licensed under the MIT License; preserve upstream attribution in [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
