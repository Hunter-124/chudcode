# Chudcode

Chudcode (`chud`) is the MIT-licensed agent-runtime dependency used by
[Chudware](https://github.com/Hunter-124/Chudware), based on OMP. Its CLI and
desktop runtime can also run independently. Upstream package and environment
variable names remain those of OMP.

## Getting started

- [Install the pinned 0.4.4 runtime](docs/INSTALL.md) without a source checkout.
- [Install the Python SDK](python/chudcode-rpc/README.md#installation)
  (`chudcode-rpc` 0.3.2, Python ≥3.11); the runtime is installed separately.
- [Contribute](CONTRIBUTING.md) or [report a security vulnerability privately](.github/SECURITY.md).
- See [`docs/rpc.md`](docs/rpc.md) for the embedding protocol and
  [`packages/coding-agent/DEVELOPMENT.md`](packages/coding-agent/DEVELOPMENT.md)
  for the source layout.

## Opt-in Code-OSS workbench candidate

An isolated, unpublished candidate pairs a native Rust launcher
(`crates/chudcode-desktop`) with a Code-OSS editor and the built-in
`chudware.chudcode-workbench` extension (`packages/chudcode-workbench`).
The editor owns files, search, terminals, Git, and language-service UI; the
extension connects the existing agent/session surfaces to a private,
authenticated desktop protocol v1 service. The bundled public `chud` remains
Chudcode **0.4.4 / RPC v2**; existing release artifacts, installers, the GUI,
and downstream pins are not replaced.

The binary editor base is the official VSCodium **1.135.06055** distribution,
SHA-256 pinned in [`packaging/workbench/base.json`](packaging/workbench/base.json),
with ChudCode identity, Open VSX, and upstream auto-update disabled. This is
candidate assembly from pinned upstream binaries, **not a published upstream
source fork**. Bun/TypeScript remains the agent/provider/plugin compatibility
engine until parity-gated native migration; Electron/TypeScript intentionally
remains at the editor boundary. The Rust launcher is not a Rust agent engine.

See the [candidate layout, build/assembly workflow, trust model, rollback, and
qualification gates](packages/chudcode-desktop/README.md#code-oss-workbench-candidate).
Editor data and user-installed extensions have separate workbench directories,
but agent settings and sessions deliberately use the existing store. Open only
trusted workspaces; editor isolation does not sandbox agent or terminal tools.

Stable promotion requires freezing CAD's 0.4.4/RPC v2/Python SDK 0.3.2 and
CloudCastle's 18.1.11 integration surfaces, proving behavior, restart,
persistence, host-tool and worker parity before replacing engine modules with Rust, and
completing provider/deployed-consumer, native platform/ISA, and signing gates.
Comparative latency/resource distributions must be profiled before claiming
performance gains. Actual final editor UI and platform qualification remain
pending; this candidate is not a completed overhaul or stable release.

## Development

For a native CLI build, install Git, Bun **1.4.0**, rustup (the checkout selects
**nightly-2026-08-12**), a C/C++ toolchain, Clang/libclang, pkg-config, OpenSSL
development files, CMake and Ninja. On Debian/Ubuntu the native prerequisites
include `build-essential clang libclang-dev pkg-config libssl-dev cmake ninja-build`.
Use the corresponding platform development tools on macOS or Windows.

Build the pinned source revision:

```sh
git -c credential.helper= clone https://github.com/Hunter-124/chudcode.git
cd chudcode
git checkout --detach 8f70d216879be0cfe6bfeb5520f2370521224330
bun install --frozen-lockfile
bun run build:native
bun --cwd=packages/coding-agent run build
packages/coding-agent/dist/omp --version
packages/coding-agent/dist/omp --smoke-test
```

The source build outputs `packages/coding-agent/dist/omp`, despite the Chudcode
identity; release installations expose `chud`. Build the native addon before
building or running the CLI. For contributions, create a branch from the current
default branch rather than the pinned detached revision, and use the checks in
[`packages/coding-agent/DEVELOPMENT.md`](packages/coding-agent/DEVELOPMENT.md).
Other packages have their own development and test commands. Local user state
lives in `~/.chudcode` (or XDG `chudcode` directories); agent and package overrides
retain the upstream `PI_CODING_AGENT_DIR` and `PI_PACKAGE_DIR` names.

### CI and releases

Pull requests and pushes run on disposable GitHub-hosted VMs with read-only
repository permissions. Contributors do not need maintainer credentials,
private caches, or access to the project's hardware. Native addons cross jobs
through artifacts from the same workflow run, retained for one day.

The public checks include TypeScript, Rust, Linux aarch64 execution under
QEMU, and Darwin arm64 compile-only checks on an Intel Mac. Emulation is not
native ARM hardware evidence; cross-compilation does not certify Apple
silicon execution, signing, or notarization.

Maintainer hardware qualification and release publication run separately in a
private, manually dispatched controller. Its source checkout is pinned to an
authorized commit rather than a pull-request ref. Public forks cannot schedule
jobs on those runners or obtain the controller's release credentials. The
private controller is not required to install Chudcode or build it from source.

On trusted hardware, `scripts/ci-native-handoff.ts` binds each native addon to
the workflow repository, run, source revision, target, and producer attempt.
`CHUDCODE_SOURCE_SHA` identifies the source revision when the workflow lives
in another repository; it must not be confused with the controller's
`GITHUB_SHA`. Consumers verify artifact sizes and hashes and never fall back
to another run or revision.

## Fork layer

Since 0.4.0 Chudcode is a thin layer on upstream `can1357/oh-my-pi` (remote `upstream`): upstream's tree is the base, and only the changes below diverge. The 18.0.8-based fork with its package/crate renames and TUI reworks is preserved at tag `archive/chudcode-fork-18.0.8`.

- Identity: `packages/coding-agent/src/brand.ts`, `packages/utils/src/dirs.ts`, help text interpolating the identity constants, the GitHub-release updater, `install.sh`.
- CAD RPC contract: host-tool inheritance with `agentId`/`parentAgentId`, `--no-mcp` and the inherited `--tools` ceiling, auth/memory/STT commands, `/session doctor`, the sharpshooter session-model fallback, and `python/chudcode-rpc`.
- Additions: `image_analyze` (`crates/chud-vision`), `cpp_static`/`cpp_runtime`/`binary_inspect`/`firmware`, editor redo, the Windows keybinding preset, keyword modes, `/cache`, `history://<id>/images`, `xd://` line selectors.
- Fork-only trees: `gui/`, `packages/chudcode-desktop`, `packages/cloudcastle-*`, `packaging/`, release scripts and `.github/`.

To sync, `git fetch upstream && git merge upstream/main`; conflicts are confined to the files above. Keep new fork changes in fork-only files with small hooks into upstream code.

## Attribution

This codebase is based on [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), itself a fork of [badlogic's pi](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/mariozechner). It is licensed under the MIT License; preserve upstream attribution in [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
