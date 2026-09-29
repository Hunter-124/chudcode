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

## Attribution

This codebase is based on [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), itself a fork of [badlogic's pi](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/mariozechner). It is licensed under the MIT License; preserve upstream attribution in [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
