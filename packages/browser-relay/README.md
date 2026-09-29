# @chudware/browser-relay

Chrome extension for attaching the agent runtime's `browser` tool to existing Chrome tabs without relaunching Chrome with `--remote-debugging-port`. Its companion relay server lives in the CLI (`chudcode browser-relay`, see `packages/coding-agent/src/tools/browser/relay/`) and multiplexes downstream debugger connections over Chrome's single attachment per tab.

## Setup

1. `chudcode browser-relay install` writes the bundled extension to `~/.chudcode/browser-relay/extension`; load it via `chrome://extensions` → Developer mode → *Load unpacked*.
2. Opt in, one of two ways:
   - **Per call** — pass `app.relay: true` on the `browser open` that needs your real browser. Works without any setting and persists nothing: the configured default for every other call and session stays whatever it already was.
   - **As the default** — `chudcode config set browser.relay true` makes the relay the default for **every session using this profile, in every project** (project-level settings, `CHUDCODE_BROWSER_RELAY`, and an explicit `app` choice still take precedence). Any session's ordinary browser call will then drive your real browser — including background sessions you aren't watching; without `app.target` such a call adopts the currently visible tab, and if it carries a `url` it navigates that tab away from what you were reading.

The relay server starts under the agent runtime's profile-independent global daemon broker when first needed. Every relay consumer holds a broker lease; the server stops after the last consumer across projects exits. The extension badge turns **on** when connected. Run `chudcode browser-relay` manually only for `--token`, `--no-group`, or a non-default port — a relay already serving the port is adopted.

`app.target` picks a specific tab by URL/title substring; without it, chudcode adopts the visible tab without stealing focus. Tabs chudcode is **actively driving** are gathered into a per-window **"chudcode" tab group** (cyan) — released when chudcode lets go of the tab and dissolved on disconnect; the rest of your tabs, pinned tabs, tabs in your own groups, and tabs you drag out are left alone. Disable with `chudcode browser-relay --no-group`.

## Development

- `bun run build` — bundles the extension into `dist/extension/`, zips it for GH releases, and regenerates the embedded CLI install assets under `packages/coding-agent/src/tools/browser/relay/extension-assets/` (**commit those**).
- `bun scripts/smoke.ts [relay-url]` — end-to-end smoke replicating chudcode's supervisor + tab-worker double-connection pattern against a live relay. It creates and removes dedicated smoke tabs without navigating existing user tabs.

## Limitations

- `chrome://`, DevTools, Web Store, and other-extension pages are not attachable and are hidden from the agent.
- Chrome shows its "is debugging this browser" infobar while any tab is attached; dismissing it detaches that tab until it navigates again.
- A tab with DevTools open can't be attached (one debugger per tab — the constraint the relay multiplexes around for its own clients).
- Anything that can reach the relay port can drive your logged-in browser. The relay binds loopback only; use `chudcode browser-relay --token <secret>` (mirrored in the extension options) if untrusted local processes are a concern.
