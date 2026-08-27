# Chudcode v0.1.0

Chudcode is Hunter's internal coding-agent build, based on omp 18.0.8. This release changes the user-facing product identity while deliberately retaining upstream package names, environment-variable names, and the `~/.omp` data format so existing tools and sessions keep working.

## What works

- The full terminal coding-agent CLI is available as `chudcode`, with compatibility aliases `chudware-code`, `chcode`, and `omp`.
- The Linux x64 compiled binary starts without Bun or Node installed. Its native addon is packaged inside the executable and extracted under `~/.omp/natives/18.0.8/` on first native use.
- The no-root installer selects the host artifact, verifies its checksum and version, and installs under `~/.local/bin`.
- Existing credentials, profiles, configuration, sessions, shell aliases, and scripts using `~/.omp` or `omp` remain compatible.

## New in this internal build

- Chudcode product naming across the CLI, startup UI, version output, executable names, installer, and release assets.
- Product version reporting is separate from upstream package versions: `Chudcode v0.1.0 (based on omp 18.0.8)`.
- A Basic settings tier with flat navigation for common controls, plus Advanced navigation and path-aware settings search.
- Numeric settings can use a validated `Custom…` value while retaining preset choices.
- `/cache` reports cache hit rate, token classes, price coverage, savings, retention/TTL, and idle time; prompt-cache miss markers are enabled by default.
- `/recent` provides a compact ten-session resume picker, while the full picker groups sessions by age and adds inline fork, rename, pin, and copy-path actions.
- Account quota usage is available in the `full` and `nerd` status-line presets.
- Editor redo is available through configurable `tui.editor.redo` keybindings.

## Fixes included since upstream 18.0.8

- Background-work status counts keep queued tasks and eval jobs visible without double-counting running subagents.
- OAuth success pages fall back to manual-close guidance when the browser refuses to close the tab.
- Settings UI conditions are checked to ensure they resolve to visibility predicates.

## Known incomplete

- The `chudcode-gui` GUI is not shipped in v0.1.0. The earlier local-fixture shell was rejected; desktop release work is blocked until Chudcode reuses and stays synchronized with the actual CAD/Chudware copilot Code workspace. Use the CLI for real work.
- Linux x64 on glibc is the only v0.1.0 binary verified on matching hardware and libc. Darwin arm64/x64, Linux arm64, musl Linux x64/arm64, and Windows x64 remain unpublished until each matching native addon and compiled executable can be built and started on its target platform.
- The installer detects all upstream build targets, but it fails loudly when the corresponding verified release asset is unavailable rather than substituting another platform's binary.
