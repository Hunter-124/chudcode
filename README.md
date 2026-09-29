# Internal agent runtime

This repository contains the internal agent runtime (`chud`) embedded by
Chudware CAD. It is not a separately distributed or marketed product. The
compiled runtime and its RPC protocol remain in use by Chudware CAD's agent.
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

These commands are documented in [`packages/coding-agent/DEVELOPMENT.md`](packages/coding-agent/DEVELOPMENT.md). Other packages have their own development and test commands.

## Attribution

This codebase is a fork of [badlogic's pi](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/mariozechner). It is licensed under the MIT License; preserve the upstream attribution in [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
