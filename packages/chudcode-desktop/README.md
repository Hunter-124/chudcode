# Agent desktop shell

Browser-based IDE shell for the internal agent runtime. A local Bun process owns
the agent session and machine-facing services; a React application connects to
it over an authenticated loopback WebSocket.

This package contains no CAD proprietary assets, CAD source, CAD runtime, CAD
protocol, or CAD-derived presentation code.

## Architecture

```text
Chromium app window or default browser
  React shell
    ├─ Monaco editor + workspace tree/search
    ├─ xterm.js terminal
    ├─ Git changes/diff/history
    ├─ D3 code/Git/agent graphs
    └─ reused collaboration transcript/composer/agent UI
             │
             │ authenticated HTTP + ordered JSON WebSocket frames
             ▼
Bun loopback server (127.0.0.1 only)
  ├─ DesktopRuntime / SessionService → agent session
  └─ ServiceRouter
       ├─ WorkspaceService + FileWatcher + WorkspaceSearch
       ├─ TerminalService → chud-natives PTY/process
       ├─ GitService → local git executable
       ├─ LspBroker → explicitly trusted local language servers
       └─ GraphService → graphify-out, LSP, Git, and agent registry
```

The layers are deliberately separated:

- `src/protocol.ts` is the typed request/response/event contract shared by host and browser.
- `src/server.ts` serves immutable web assets, authenticates HTTP/WebSocket requests, bounds frame queues, and owns the single-instance lease.
- `src/runtime.ts` adapts agent/session events to desktop frames.
- `src/service-router.ts` routes machine-facing methods without exposing arbitrary commands over the wire.
- `src/services/` owns workspace containment, file watching/search, Git, terminal, and trusted LSP processes.
- `src/graph-service.ts` adapts Graphify, LSP, Git, and the live agent registry to one graph snapshot contract.
- `src/web/desktop-client.ts` and `desktop-store.ts` maintain the ordered client connection and external-store state.
- `src/web/` contains the React shell and the editor, terminal, Git, graph, session, task, transcript, composer, and agent surfaces.

The browser is a view/controller, not a privileged filesystem process. Workspace, Git, terminal, LSP, and agent operations cross the typed local protocol and are revalidated by the host.

## Requirements

- Bun **1.4.0**, matching the repository `packageManager` pin.
- A supported desktop browser. The launcher prefers Chromium, Chrome, Brave, or Edge in app-window mode and falls back to the OS default browser.
- `git` on `PATH` for source-control features.
- Platform-compatible `@chudware/natives` artifacts for PTY and native workspace search.
- Language-server executables only when the embedding host supplies trusted LSP specifications; none are launched from browser-provided command lines.

Install the monorepo dependencies from the repository root:

```sh
bun install --frozen-lockfile
```

## Build

From the repository root:

```sh
bun --cwd packages/chudcode-desktop run build
```

This creates:

- `packages/chudcode-desktop/dist/web/` — minified browser HTML, JavaScript, CSS, Monaco workers, and assets.
- `packages/chudcode-desktop/dist/chudcode-desktop[.exe]` — a compiled standalone server/launcher with its Bun runtime and JavaScript dependency graph embedded.

The packaging script `scripts/package-chudcode-desktop.ts` assembles the compiled CLI, desktop launcher, native GUI, adjacent runtime assets, version metadata, and repository notices. The archive contains no source tree, `node_modules`, or Bun interpreter dependency.

## Run

Inside an unpacked release archive, the compiled launcher resolves `chud`, `chudcode-gui`, `web/`, `assets/`, `VERSION`, and notices only beside its own executable. It launches the adjacent native GUI by default:

```sh
./chudcode-desktop
```

Use `--browser` to attach a browser client instead. Packaged mode fails before starting the server if any adjacent component is absent.

Source execution is intentionally explicit and accepted only in this checkout with built web assets:

```sh
bun packages/chudcode-desktop/src/launch.ts --source-mode
```

The launcher uses the current project directory as the initial workspace context, creates a single-instance lease under the agent runtime directory, and reuses the existing desktop process when one is already active.

## Development

The package `dev` script watches the Bun server source. It expects `dist/web/` to exist. For host-only changes:

```sh
bun --cwd packages/chudcode-desktop run build
bun --cwd packages/chudcode-desktop run dev
```

For browser and host changes, use two terminals from the repository root:

```sh
# Terminal 1: rebuild browser assets
bun build packages/chudcode-desktop/src/web/index.html \
  --outdir=packages/chudcode-desktop/dist/web \
  --target=browser --watch

# Terminal 2: restart the host on source changes
bun --cwd packages/chudcode-desktop run dev
```

The dev launcher opens the native GUI. Pass `--browser` directly to the source entrypoint when testing the browser client. The browser build watcher does not provide hot-module replacement; refresh after it emits updated assets.

Useful focused commands:

```sh
# Type-check host and browser projects
bun --cwd packages/chudcode-desktop run check

# Run only this package's tests
bun test packages/chudcode-desktop/test
```

## Security model

This service is intentionally local and single-user:

- Bun binds only to `127.0.0.1`. Host headers must name the active loopback authority and port; supplied origins must be same-port HTTP loopback origins.
- Startup generates a random 32-byte (256-bit) bearer token. Comparisons are constant-time. The bootstrap query token is exchanged for a `HttpOnly; SameSite=Strict` cookie and removed by redirect.
- The bootstrap URL is a secret. Do not paste it into logs, chat, tickets, or remote browser sessions. Anyone able to reach the loopback port and obtain the token acts with the desktop process's user permissions.
- Static responses use `nosniff`, no-referrer, same-origin resource/opener policies, and an app CSP that rejects objects, framing, non-local connections, and non-self scripts.
- WebSocket input is limited to 1 MiB; outbound frames use bounded queues and backpressure handling.
- Static paths are decoded, normalized, checked against traversal, and real-pathed inside `dist/web` before serving.
- Workspace paths are canonicalized and confined to the opened root. Writes use expected content hashes to surface concurrent edits instead of silently overwriting them.
- LSP process commands come only from trusted host settings. Wire requests can request supported LSP operations but cannot choose an executable or arguments.
- Terminal and agent actions are intentionally powerful local operations. Open only trusted workspaces and run the desktop under an account with appropriate least privilege.

Do **not** bind this server to a LAN address, publish it through a tunnel, or place it behind a reverse proxy. It has no remote-user authentication, TLS termination, tenant isolation, or authorization boundary beyond possession of the local token.

## Feature map

| Area | Direct behavior |
| --- | --- |
| Agent sessions | Create, select, fork, rename, pin, and delete local sessions; render transcript/tool activity; submit prompts; inspect and control registered agents. |
| Workspace and editor | Open recent/local roots; browse, create, rename, copy, and remove files/directories; quick-open and content search; Monaco models, tabs, save hashes, file-change conflict comparison, and source navigation. |
| Language services | Host-managed LSP document lifecycle, diagnostics, definition/reference navigation, completion/code-action plumbing, and workspace-symbol search for configured trusted servers. |
| Terminal | Multiple xterm.js tabs backed by local native PTYs, streaming output, resize/fit, paste, reconnect/error states, and orderly process shutdown. |
| Source control | Repository status, staged/unstaged changes, unified and hunk diffs, stage/unstage/revert, commit, branches, remotes, fetch/pull/push/checkout, conflict safeguards, and history. |
| Graphs | Code graph from `graphify-out/graph.json` with trusted-LSP fallback, Git history graph, and live agent/lifecycle graph; zoom, drag, fit, filter, scope, pin, source-open, and list fallback. |
| Shell | Resizable/persisted primary, editor, bottom, and secondary regions; activity routes; sessions/tasks/settings utility views; Chudcode composer/transcript/agent presentation; reconnect and error banners. |
| Theme and motion | Shared semantic color tokens, dark/light system preference, persisted layout, and OS/runtime reduced-motion handling. |

## Keyboard and accessibility

The shell uses semantic landmarks, labeled controls, tab/list/tree roles, live status/error regions, and focusable editor, diff, terminal, and graph surfaces. Icon-only actions carry accessible names. The graph provides both keyboard navigation and an ordered-list fallback. Motion-heavy editor, Git, graph, terminal, and shell effects respect `prefers-reduced-motion`.

Shell shortcuts are ignored while typing in text inputs:

| Shortcut | Action |
| --- | --- |
| `Ctrl+B` | Toggle primary sidebar |
| `Ctrl+Alt+B` | Toggle transcript/agent sidebar |
| `Ctrl+1` | Focus editor host |
| `Ctrl+Shift+E` | Explorer |
| `Ctrl+Shift+F` | Search activity |
| `Ctrl+Shift+G` | Source control |
| `Ctrl+\`` | Terminal |
| `Ctrl+Shift+Y` | Graph |
| `Ctrl+Shift+U` | Sessions/tasks/settings utility |
| `Ctrl/Cmd+P` | Quick Open inside the editor workspace |
| `Ctrl/Cmd+Shift+F` | Search workspace contents inside the editor workspace |

Inside a focused graph, use arrow keys, `Home`/`End`, `Enter`, and `Space` to move among nodes and open source. Monaco and xterm.js expose their own browser accessibility modes and keyboard behavior.

Known accessibility limit: split-pane separators are currently pointer-resized. Keyboard users can use the sidebar shortcuts and reset the persisted layout from Settings, but cannot yet adjust separator dimensions from the keyboard.

## Known platform limits

- This is a browser-hosted desktop shell, not a native WebView application. There is no installer, OS auto-update integration, native menu bar, or offline runtime bundle in this package.
- App-window launch is implemented for Chromium-family executables on Linux, macOS, Windows/Cygwin, and several BSD/Unix variants. When none is found, the OS default-browser command is used; Android and uncommon Unix platforms receive best-effort fallback behavior.
- The service is loopback-only and single-instance per runtime directory. It is not a remote IDE or multi-user collaboration server.
- The server uses plain HTTP because it is confined to loopback. HTTPS origins and non-loopback host/origin headers are rejected.
- Git features require a local Git executable and repository. Network Git actions inherit the user's existing credentials, transport configuration, and connectivity.
- Terminal availability depends on the matching `chud-natives` binary and an executable user shell. The desktop service caps itself at 32 terminal sessions and bounds buffered input/output to prevent unbounded memory growth.
- LSP support is inert until a trusted host configuration supplies installed language servers. The browser cannot install or select arbitrary servers.
- Code graphs prefer a workspace's existing `graphify-out/graph.json`; otherwise they require a configured LSP workspace-symbol provider. Default snapshots are bounded to 250 code nodes, 750 edges, and 64 reference queries.
- Browser storage keeps layout preferences for that browser profile. Session files, workspaces, Git state, terminals, and agent state remain host-owned and are not synced by this package.
- Monaco and xterm browser/screen-reader behavior varies by browser and assistive technology. Chromium-family browsers are the primary app-window target; verify the chosen production browser/AT combination before deployment.

## Licensing

This code is MIT-licensed under the repository `LICENSE`. Direct desktop dependency versions, source URLs, uses, notice locations, and source/binary obligations are recorded in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
