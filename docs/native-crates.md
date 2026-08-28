# Native Crates

Contributor map for Rust workspace members under `crates/`. They are implementation details behind `@chudware/natives` and its embedded shell; package consumers use JavaScript entrypoints, not these crate APIs.

The root `Cargo.toml` lists every crate under `crates/` explicitly in `workspace.members` — add new crates there. It also patches crates.io `brush-core` to the vendored copy.

## First-party crates

| Crate           | Path                                              | Role and consumers                                                                                                                                              |
| --------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chud-natives`    | [`crates/chud-natives`](../crates/chud-natives)       | Top-level N-API `cdylib`. It exposes the JS-visible API and depends on `chud-ast`, `chud-iso`, `chud-shell`, `chud-voice`, and `chud-walker`.                              |
| `chud-builtins`   | [`crates/chud-builtins`](../crates/chud-builtins)     | Every builtin the embedded shell installs: a patched fork of brush's POSIX/bash builtins, plus one module per in-process command-line utility (`cat`, `grep`/`rg`, `sed`, `ls`, `find`, `jq`, `fd`, `diff`, `ps`, `top`, `kill`, the moreutils set, …). `src/host.rs` holds the `Utility` trait and the `Host` view of the shell (stdio, working directory, exported environment, cancellation) that the utilities run against. Ports of uutils coreutils/findutils/sed and jaq live here too; see the crate `LICENSE` for third-party notices. |
| `chud-shell`      | [`crates/chud-shell`](../crates/chud-shell)           | Persistent embedded brush shell, command execution/minimization, process plumbing, filesystem walking, and in-process command integration used by `chud-natives`. |
| `chud-voice`      | [`crates/chud-voice`](../crates/chud-voice)           | Cross-platform microphone/playback and Opus/WebRTC support used by the `AudioCapture`, `AudioPlayback`, and `LiveWebRtcPeer` bindings.                          |
| `chud-ast`        | [`crates/chud-ast`](../crates/chud-ast)               | tree-sitter/ast-grep language registry, matching/editing, block analysis, and summarization support across the workspace grammar set.                           |
| `chud-iso`        | [`crates/chud-iso`](../crates/chud-iso)               | Isolation backend implementations and diffing for APFS, Linux/Windows clone/reflink paths, overlayfs, ProjFS, and recursive copy fallback.                      |
| `chud-walker`     | [`crates/chud-walker`](../crates/chud-walker)         | Parallel, cache-aware filesystem walker using ignore rules and globsets; shared by native grep/glob/workspace paths and shell commands.                         |

## Vendored workspace crates

| Group | Paths | Purpose |
| ----- | ----- | ------- |
| Brush | [`crates/vendor/brush-core`](../crates/vendor/brush-core) | Vendored shell engine consumed by `chud-shell` and `chud-builtins`. Its manifest retains upstream package metadata; a workspace patch selects this local fork. |

`chud_builtins::utility_builtins()` and `chud_builtins::process_builtins()` are the authoritative lists of the commands linked into the embedded shell; `chud-shell` decides which of them to register. A directory being a workspace member does not by itself mean that `chud-natives` exposes it as a JavaScript API.

## Boundary map

```text
@chudware/natives JS entrypoints
  -> chud-natives (N-API conversion, platform bindings, task boundaries)
       -> chud-ast / chud-iso / chud-voice / chud-walker
       -> chud-shell
            -> brush-core (parser, expansion, interpreter)
            -> chud-builtins (bash builtins + utility builtins; host.rs: per-invocation I/O and cwd)
```

For the loader and JS boundary, see:

- [`natives-architecture.md`](./natives-architecture.md)
- [`natives-addon-loader-runtime.md`](./natives-addon-loader-runtime.md)
- [`natives-binding-contract.md`](./natives-binding-contract.md)

Subsystem details live in:

- [`natives-build-release-debugging.md`](./natives-build-release-debugging.md)
- [`natives-media-system-utils.md`](./natives-media-system-utils.md)
- [`natives-rust-task-cancellation.md`](./natives-rust-task-cancellation.md)
- [`natives-shell-pty-process.md`](./natives-shell-pty-process.md)
- [`natives-text-search-pipeline.md`](./natives-text-search-pipeline.md)
- [`fs-scan-cache-architecture.md`](./fs-scan-cache-architecture.md)

## Documentation policy

These crates remain contributor-facing implementation details. Promote one to standalone user-facing documentation only when it gains a public API or executable consumed independently of `@chudware/natives`; see [`user-facing-packages.md`](./user-facing-packages.md).
