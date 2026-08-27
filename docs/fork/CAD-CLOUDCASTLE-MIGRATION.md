# Migrating CAD (and CloudCastle) onto the fork

Short version: **do the surgical version now, not the full jump.** A branch is
ready and verified for the safe path. The full migration has a real blocker I
found while working, and it needs you present to validate CAD's runtime.

## What CAD actually consumes

CAD does **not** run the `chudware-code` CLI. It vendors a curated subset of Chudware Code source and
talks to it over a private bun sidecar (`vendor/omp/bridge/src/bridge.ts`,
newline-delimited JSON-RPC on stdio, spawned by CAD's own C++ `OmpBridgeClient`
and Python `omp_bridge.py`).

Vendored packages, per `vendor/omp/OMP_VENDOR.lock`:
`ai`, `catalog`, `utils`, `wire`, `mnemopi`, `snapcompact` — pinned to upstream
sha `d1239fd3e57a48a35b483663d16ab078db75a87b` (2026-07-27), 714 files, one
sha256 each, and `vendor_omp.py --verify` fails the build on any drift.

Deliberately **not** vendored: `pi-agent-core`, `pi-coding-agent`, `pi-tui`.

### Why that's good news

Almost everything we changed cannot affect CAD:

| Our change | Package | Affects CAD? |
| --- | --- | --- |
| editor redo | `tui` | No |
| status-bar duplicate count | `coding-agent` | No |
| subagent label sanitize | `coding-agent` | No |
| auto-update | `coding-agent` | No |
| escape dismissal | `coding-agent` | No |
| draft autosave | `coding-agent` | No |
| anti-sleep | `coding-agent` | No |
| **OAuth close button** | **`ai`** | **Yes** |
| **Cursor effort + releaseDate** | **`catalog`** | **Yes** |

CAD's `ai_roles`, `agent.prewalk`, its own status bar and its own Sessions
directory are independently invented and not wire-compatible with Chudware Code's, so the
`/agents`+`/models/roles` merge, the settings consolidation and the status-bar
work are all safe by construction.

## The blocker on a full jump

CAD pins the **native** from npm while vendoring the rest as source:

```
"@oh-my-pi/pi-natives": "17.1.5"
"@oh-my-pi/pi-utils":   "17.1.5"
"@oh-my-pi/pi-ai":      "workspace:*"   (vendored source)
"@oh-my-pi/pi-catalog": "workspace:*"   (vendored source)
```

Our fork branches are based on either old main (`f833810d0e`, 2026-07-23) or
current main (`d17c270090`, v18.0.7). Re-vendoring source from an 18.x base while
`pi-natives` stays at 17.1.5 is very likely to break, and I hit exactly this
class of failure today by accident: the 17.x native does not export
`NativeDesktopSession`, which 18.x's `desktop-adapter.js` expects —

```
TypeError: WeakMap keys must be objects or non-registered symbols
  at adaptDesktopSession (packages/natives/native/desktop-adapter.js:339)
```

So a full jump means bumping `pi-natives` to 18.x too, which is a genuine
migration: 5400+ upstream commits of drift across `ai`/`catalog`/`utils`/
`wire`/`mnemopi`/`snapcompact`, any of which can move an export the bridge
depends on (`AuthStorage`, `getBundledModel`, `PROVIDER_REGISTRY`,
`SqliteAuthCredentialStore`, snapcompact's frame/archive shape). I cannot
validate that end to end without running CAD's C++ core and hostd.

**I did not execute it.** Breaking a private production repo unattended is not
worth the convenience.

## Do this now — the surgical path (ready)

Branch `cad/oauth-fix-on-vendored-base` on the fork is the OAuth fix cherry-picked
onto **CAD's exact pinned base**. No version jump, no drift:

```
10 insertions, 3 deletions across 2 files, on d1239fd3e5
bun test packages/ai/test/callback-server-launch-route.test.ts → 8 pass, 0 fail
```

This matters because CAD inherits the OAuth "Close Window does nothing" bug
verbatim — same `oauth.html`, served by the same callback server the bridge calls
through `AuthStorage.login()`. Fixing it upstream and re-vendoring fixes it in
CAD for free.

To adopt:

```bash
cd /home/hunter/Repositories/CAD
python3 scripts/vendor_omp.py \
  --from https://github.com/Hunter-124/oh-my-pi.git \
  --sha <sha of cad/oauth-fix-on-vendored-base> \
  --packages ai catalog utils wire mnemopi snapcompact
python3 scripts/vendor_omp.py --verify
# then CAD's own build + bridge smoke test
```

Expected diff: only `packages/ai/src/registry/oauth/oauth.html` and its test.
If `--verify` reports anything else, stop — the base moved.

## Later — the full jump, when you're around

1. Pick a fork commit and bump `pi-natives`/`pi-utils` npm pins to the matching
   major **in the same commit**. Mismatched native and source is the failure mode.
2. Re-vendor, then grep the bridge for every symbol it imports from
   `ai`/`catalog`/`utils`/`wire`/`mnemopi`/`snapcompact` and confirm each still
   exists with the same shape.
3. Exercise the bridge specifically: provider auth (`AuthStorage.login`), model
   lookup (`getBundledModel`), and a snapcompact round-trip — those are the three
   contract surfaces the audit flagged as most likely to move.
4. Only then re-run `--verify` and commit the lockfile.

## CloudCastle

Not audited this session. Before migrating it, run the same three checks: how it
consumes Chudware Code (vendored source vs spawned binary vs npm), which packages it
depends on, and whether it pins a native. If it spawns the `chudware-code` CLI rather than
vendoring, the calculus is completely different — a CLI consumer is affected by
the `coding-agent` changes that CAD is immune to.
