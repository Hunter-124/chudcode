# Chudcode v0.2.0

Chudcode is Hunter's internal coding-agent build, based on omp 18.0.8. This release makes
`chudcode update` actually work, and lands the in-flight work the repository needed in order
to build at all.

## Self-update now works

v0.1.0 could not update itself. Three independent faults stacked up, and the startup banner
showed all of them at once — it offered `18.0.10`, then failed with
`GitHub release v18.0.10 has 0 assets named chudcode-linux-x64`:

- The update check read **upstream's** npm package, so a fork on `0.x` was compared against
  omp's `18.x` line and always looked out of date. Latest-version now comes from this
  repository's own GitHub releases.
- The download then looked for that tag in `can1357/oh-my-pi`, whose assets are named
  `omp-*`. The updater now resolves assets from this repository.
- Even with the right release, verification could never pass: the updater only understood an
  `omp/18.0.8` version banner, while this build prints
  `Chudcode v0.2.0 (based on omp 18.0.8)`. Every download would have installed, failed
  verification, and rolled back. It now reads the product version from the banner it
  actually prints.

Homebrew, mise and Nix installs are refused with a pointer to the releases page instead of
being routed, because those coordinates resolve upstream omp — updating through them would
have replaced Chudcode with a different program. The release is pinned as a binary
distribution for the same reason: a package-manager path would run
`bun add @oh-my-pi/pi-coding-agent`.

Updating from v0.1.0 requires one manual install, since the fix ships *in* v0.2.0. After
that, `chudcode update` is self-sufficient.

## Private browser stages

A headed managed browser asked for a private computer stage but was keyed like every other
headed browser, so two sessions would have shared one Chromium — and one desktop. Browsers
are now keyed per stage owner, the stage hold is released on every teardown path including a
wedged browser, and a browser that cannot get a stage fails instead of falling back to the
real display.

## Build integrity

`main` did not build: six imports resolved to modules that were never committed, and a draft
save path called a method no session manager declared. That work is now in the tree, and
`packages/coding-agent` type-checks clean.

The release build derives its version from the binary's own compiled-in constants and
refuses to stage when `install.sh` disagrees, which is how v0.1.0's installer came to pin a
version the binary no longer reported.

## Verification

- Suites green: `pi-ai` 4251, `pi-tui` 1410, `pi-catalog` 782, `pi-utils` 850, `pi-agent`
  538, `pi-natives` 115 plus 289 Rust tests, `mnemopi` 457, `stats` 107.
- `update-cli` 86/86, including the fork-channel, prerelease-gating and version-banner
  contracts.
- The staged binary is started from a clean HOME to prove its embedded native addon extracts
  and loads; `--version`, `--smoke-test` and `models` are all exercised.
