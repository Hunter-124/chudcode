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

CI jobs on this runner hand native addons to the TypeScript suites through
`<runner work>/chudcode/ci-handoff/<repository>/<run id>/<source sha>/`
(`scripts/ci-native-handoff.ts`) instead of GitHub artifact storage. Each
target is published atomically with a manifest recording its exact target,
source SHA, run id, producer attempt, byte count and SHA-256; consumers copy
and verify the bytes and never fall back to another run, revision or artifact.
Handoffs are retained on the NVMe: nothing prunes them automatically, since an
age-based sweep could delete files a queued, long-running or re-run job still
needs. Only release runs upload `native-addons` (2-day retention) for the
Windows and Mac release jobs.

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

Ordinary CI checks ARM without the offline physical M2 or paid hosted Macs:

- `linux_arm64_emulated` runs on `cc-linux-chudcode`. It builds every
  `//crates/...` test with the pinned Bazel zig glibc 2.17 toolchain
  (`--config=linux-arm64-qemu`) and executes the aarch64 ELF binaries through
  the utility VM's own kernel `qemu-aarch64` binfmt handler, so child
  processes and re-execs run as aarch64 too, against the GNU cross sysroot
  `/usr/aarch64-linux-gnu`. It then installs this run's `linux-arm64` addon,
  built by its own `native_addon_build_linux_arm64` job (not part of the
  x64/Windows `native_addon_build` matrix, so nothing outside the ARM lane
  waits for it), from the same-runner handoff and runs the `packages/natives`
  suite on the official aarch64 Bun build of the pinned Bun version, SHA-256
  verified and cached in the runner's own tool cache (x64 Bun cannot load an
  aarch64 addon). `scripts/ci-arm64-emulation.ts` refuses to run without the binfmt
  handler and sysroot, or with any addon other than the aarch64 one present.
- `darwin_arm64_compile_only` runs on `cc-mac-chudcode-intel`
  (`scripts/ci-darwin-arm64-compile-only.sh`). With the Xcode SDK it
  cross-compiles `//:natives-darwin-arm64` with the canonical addon driver,
  every Rust test binary, the GUI and its headless tests. All use
  `--config=darwin-arm64-compile-only`, including the same addon Rust flags,
  so subsequent targets reuse that compilation. Each output must be a thin
  arm64 Mach-O. Nothing is executed.

The ARM addon producer and Darwin cross-build start only after the existing
TypeScript, Rust-validation and check jobs pass. No non-ARM job needs either
ARM producer or emulation, so the private runner serves baseline work first.

Every ARM step has a hard budget and never retries. Jobs are capped at 30
min (`native_addon_build_linux_arm64`), 45 min (`linux_arm64_emulated`) and
90 min (`darwin_arm64_compile_only`). Inside them,
`scripts/ci-deadline.ts <seconds> -- <command>` runs each long command in its
own process group, sends SIGTERM and then SIGKILL after 15 s, and exits 124
on expiry: arm64 addon build 25 min, emulated `bazel test` 30 min (per-test
timeouts 300/1200/1500/1800 s), arm64 Bun download 3 min, probe 2 min,
`packages/natives` suite 10 min, and the whole Darwin compile-only script 75
min.

TTY teardown publishes `dead` only after queue cleanup, under the same lock
that rejects late appends. Shell child-stop observation subscribes before
checking a pending stop for that specific PID; one child cannot consume another
child's stop status. Both paths are exercised natively and as Linux aarch64.

Emulated Linux results are not native ARM hardware evidence, and Intel
cross-compilation is neither native Apple silicon runtime evidence nor a
release, signing or notarisation input. Native ARM qualification and the
trusted Apple signing lane remain separate.

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
