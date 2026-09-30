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

## Fork layer

Since 0.4.0 Chudcode is a thin layer on upstream `can1357/oh-my-pi` (remote `upstream`): upstream's tree is the base, and only the changes below diverge. The 18.0.8-based fork with its package/crate renames and TUI reworks is preserved at tag `archive/chudcode-fork-18.0.8`.

- Identity: `packages/coding-agent/src/brand.ts`, `packages/utils/src/dirs.ts`, help text interpolating the identity constants, the GitHub-release updater, `install.sh`.
- CAD RPC contract: host-tool inheritance with `agentId`/`parentAgentId`, `--no-mcp` and the inherited `--tools` ceiling, auth/memory/STT commands, `/session doctor`, the sharpshooter session-model fallback, and `python/chudcode-rpc`.
- Additions: `image_analyze` (`crates/chud-vision`), `cpp_static`/`cpp_runtime`/`binary_inspect`/`firmware`, editor redo, the Windows keybinding preset, keyword modes, `/cache`, `history://<id>/images`, `xd://` line selectors.
- Fork-only trees: `gui/`, `packages/chudcode-desktop`, `packages/cloudcastle-*`, `packaging/`, release scripts and `.github/`.

To sync, `git fetch upstream && git merge upstream/main`; conflicts are confined to the files above. Keep new fork changes in fork-only files with small hooks into upstream code.

## Attribution

This codebase is based on [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), itself a fork of [badlogic's pi](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/mariozechner). It is licensed under the MIT License; preserve upstream attribution in [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
