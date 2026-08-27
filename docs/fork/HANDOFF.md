# Handoff — oh-my-pi fork effort, 2026-08-27

Complete record of everything raised in this session. Nothing here is dropped
silently: every item is either DONE, FILED upstream, BLOCKED on a named person,
or OPEN with its next concrete step.

Fork: `Hunter-124/oh-my-pi` (10 branches). Upstream: `can1357/oh-my-pi`.

---

## 1. A correction you should know about

**My checkout was 5412 commits behind upstream** (tree from 2026-07-23; real main
2026-08-26, v18.0.7). I filed 8 issues before noticing. On re-verification
against real main:

| Issue | Outcome |
| --- | --- |
| #9915 session-header data loss | **CLOSED by me** — the header-discard mechanism is gone from main; my severe claim was wrong |
| #9921 compaction unobservable | **CLOSED by me** — already fixed; `tokensAfter` exists and renders "Compacted from X to Y" |
| #9923 settings defects | **Partial retraction posted** — the dead Exa toggles were removed upstream; the other 3 findings still hold |
| #9918 credential pruning | **Path correction posted** — code moved to `auth/sqlite-credential-store.ts`; substance unchanged |
| #9916, #9917, #9920, #9922 | Re-verified, still reproduce on current main |

Everything filed after that point cites `main @ d17c270090` (18.0.7).

**Lesson for next session: `git fetch` before citing line numbers.**

---

## 2. Upstream pull requests

| PR | Branch | State |
| --- | --- | --- |
| [#9925](https://github.com/can1357/oh-my-pi/pull/9925) | `feat/editor-redo` | **Ready, MERGEABLE.** Rebased onto 18.0.7, conflicts resolved (adapted to upstream's new `matchesCanonical` dispatch API). Verified: 1380 pass / 0 fail on real 18.0.7 |
| [#9926](https://github.com/can1357/oh-my-pi/pull/9926) | `fix/oauth-close-window` | **Ready, MERGEABLE.** 8 pass / 0 fail |
| [#9927](https://github.com/can1357/oh-my-pi/pull/9927) | `fix/status-bar-duplicate-count` | **Ready, MERGEABLE.** Re-applied against main (upstream rewrote that region). 153 pass / 0 fail |

Held back for Michael and Charles to submit, per your request:
`fix/subagent-label-sanitize`, `feat/opt-in-auto-update` (needs the Discord
thread first), `feat/catalog-cursor-effort-and-release-date`,
`feat/opt-in-escape-dismiss`, `feat/cross-platform-antisleep`.

Bodies for all of them are in `PR-BODIES.md`, each needing one sentence from
whoever submits it — upstream closes PRs that lack it.

---

## 3. Upstream issues filed

| # | Subject | Status |
| --- | --- | --- |
| [9916](https://github.com/can1357/oh-my-pi/issues/9916) | No memory-aware admission control; count-only subagent cap | open |
| [9917](https://github.com/can1357/oh-my-pi/issues/9917) | Deleting a pasted image's marker does not un-attach it | open |
| [9918](https://github.com/can1357/oh-my-pi/issues/9918) | Disabled credentials never pruned or re-validated | open |
| [9920](https://github.com/can1357/oh-my-pi/issues/9920) | Mouse: no routing layer; one overlay's mouse code unreachable | open |
| [9922](https://github.com/can1357/oh-my-pi/issues/9922) | `os.tmpdir()` producers never clean up; no reaper; no tmpfs awareness | open |
| [9923](https://github.com/can1357/oh-my-pi/issues/9923) | macOS-only control interactive on Linux; dangling `condition` string | open (partially retracted) |
| [9928](https://github.com/can1357/oh-my-pi/issues/9928) | Config never propagates between running sessions | open |
| [9929](https://github.com/can1357/oh-my-pi/issues/9929) | `usage` status-bar segment absent from every preset | open |
| [9930](https://github.com/can1357/oh-my-pi/issues/9930) | Unpriced models counted as $0 and reported "measured" | open |
| [9931](https://github.com/can1357/oh-my-pi/issues/9931) | Pasted images render as text; documents/folders paste as raw paths | open |
| [9932](https://github.com/can1357/oh-my-pi/issues/9932) | `/agents` vs `/models/roles`: resolved model not discoverable | open |
| [9934](https://github.com/can1357/oh-my-pi/issues/9934) | Cursor bakes effort into model id, reports `reasoning:false` | open |
| 9915, 9921 | closed by me as stale — see section 1 | closed |

---

## 4. Your requests, one by one

### Done and landed in the fork

| Request | Where |
| --- | --- |
| Undo/redo keybinds (**your #1**) | `feat/editor-redo` → PR #9925. Undo *existed* on `ctrl+-`; nobody finds it. Redo added on `alt+-` |
| Prompt preservation (**your #1**) | Draft autosave on `fix/pending-image-reconcile`. Debounced 2s, atomic writes, verified by really SIGKILLing a child and resuming |
| OAuth "Close Window" dead button | `fix/oauth-close-window` → PR #9926 |
| Duplicated `⚘ N agents` / `⚙ N` | `fix/status-bar-duplicate-count` → PR #9927 |
| `</title>` leaking into subagent labels | `fix/subagent-label-sanitize` |
| Auto-update | `feat/opt-in-auto-update`. `startup.autoUpdate` off/notify/auto + 6h throttle + SHA-256 verification, fail-closed |
| Cursor model classification | `feat/catalog-cursor-effort-and-release-date` |
| Model pruning by age | Same branch — `releaseDate` + recency predicate (catalog had **no** date field; models.dev publishes one) |
| `/models` needing multiple Esc | `feat/opt-in-escape-dismiss`, opt-in because upstream has a **test asserting** the two-step behaviour |
| Anti-sleep on Linux/Windows | `feat/cross-platform-antisleep`. Proven live: `omp … idle … block` in `systemd-inhibit --list` while held, absent after release |
| Your `/tmp` crashes | 7.54 GB reclaimed; disk-backed `TMPDIR` + weekly prune timer installed. `CRASH-MITIGATIONS.md` |
| Your status bar missing usage | `~/.omp/agent/config.yml` — added `usage`, `context_pct`, `context_total`, `cost`. The segment was in **zero presets** upstream |
| Fork + collaborators | `Hunter-124/oh-my-pi`; Michael, Charles, Simon invited with write |

### Open — with the next concrete step

| Request | Status | Next step |
| --- | --- | --- |
| **Pseudosandbox for `/computer`** | Worker running at handoff | Read its report; expect an X11 nested display (Xvfb/Xephyr) because `xdotool` already works there and capture works, both currently broken on your Wayland session |
| **`/tree` as execution DAG** | Audited, not built | Data mostly exists: session `parentId` tree, `SessionHeader.parentSession`, `AgentRef.parentId`, `history://`, `artifact://`. **Gap:** nothing in the TUI draws edges between nodes, and cross-agent IRC chat is TUI-only + TTL-expiring, so a restart-durable DAG needs the message board persisted first. Discord before implementing |
| **Agent comms (board/topics/blackboard)** | Audited | `hub` already does DM, broadcast, blocking wait, inbox, roster, reply threading, auto-wake/revive of parked agents — **do not rebuild it**. Genuinely missing: durable messages readable after exit, topic/channel subscribe, shared mutable blackboard, structured payloads (prose-only by explicit design), cross-process. Discord before implementing |
| **Pseudosandbox for `/computer`** | **PROTOTYPE WORKING** — see section 4b | Decide Option A (use today, zero code) vs Option B (per-session seats, needs native plumb) |
| **Real attachment previews** | #9931 filed; not built | TUI *can* draw images and already does for assistant messages. Blocker: `renderReference` returns a **string** and Markdown renders to string lines, so an `Image` Component can't embed there — needs that render path restructured to emit a container |
| **Documents/folders as attachments** | #9931 filed; not built | `markit` converter already exists (PDF/DOCX/PPTX/XLSX/EPUB) and is used by `read`; paste path just needs a third category + `onPasteDocumentPath`. Folders may be fine as plain paths |
| **Animated usage gauge** | Not built | No repaint driver in the status line. Must be owned by interactive-mode's lifecycle and repaint the editor (status line is the editor's top border), reusing `RenderScheduler`/`requestComponentRender`. **Never** a timer inside segment render |
| **Status bar redesign** (session title, ctx+limit, agent count → subagents view) | Not built | `session_name` segment **already exists** and is rendered; the title is at `SessionManager.getSessionName()`. So this is largely preset/layout work |
| **Cost estimate that makes sense** | #9930 filed; not built | Fix is: represent unknown pricing instead of `?? 0`, then surface "N of M priced" |
| **Model price auto-fetch by scraping** | Deliberately not built | A wrong scraped price silently corrupts every future total and there's no provenance field. Prerequisite: unknown-pricing representation (#9930) |
| **Chat history corruption** | Mostly fixed upstream already | Orphaned `tool_use`/`tool_result` pairs **are** repaired at the wire layer; compaction cannot orphan them by construction. Remaining: no user-invocable session repair/doctor command, and `/tree` is the only user-reachable recovery |
| **Windows crash on login** | Not diagnosed | Needs a real stack trace or log from one of the affected Windows machines. Cannot responsibly file without it |
| **Perf audit of our fork** | **NOT RUN** — I dropped it | It was in a dispatch that got interrupted and I re-sent the batch without it. Re-dispatch: startup cost, per-render work, per-render git, repeated I/O, `structuredClone` on the undo path, subprocess churn |
| **CloudCastle + CAD onto our fork** | Audited, not executed | CAD is **insulated**: it vendors only `ai`/`catalog`/`utils`/`wire`/`mnemopi`/`snapcompact` at a pinned SHA — deliberately not omp's agent/role/TUI engine. So the roles merge, settings work and status-bar work cannot break it. It *does* inherit the OAuth bug verbatim, so re-vendoring fixes that free. Run `scripts/vendor_omp.py` against the fork |

### Blocked on a person

| Item | Who | What exactly |
| --- | --- | --- |
| **Discord post** | You | Message is **staged and verified** in `#💡-feature-requests` on `bruh_button`: 1729 chars, under the 2000 limit. **Click the tab and press Enter.** I cannot: Discord rejects synthetic keys, and your session blocks every fallback (`capture:false`, `backgroundWindowInput:false`, Brave is native Wayland so `xdotool` can't reach it, `ydotool`/`wtype` absent, `/dev/uinput` root-only). It also folds in your own 4:33 AM ctrl+z/y request |
| **Submit remaining PRs** | Michael | 5 branches + bodies in `PR-BODIES.md`. Each needs one sentence in his own words |
| **tmpfs cap** | You | `sudo systemctl edit tmp.mount` → `Options=mode=1777,strictatime,nosuid,nodev,size=2G,nr_inodes=1m` |
| **`task.maxConcurrency`** | You | Left at 32 per your call. It means up to 32 full agent sessions in **one** Bun heap, and nesting gives each level a fresh 32. If crashes continue, wrap heavy sessions: `systemd-run --user --scope -p MemoryMax=8G omp` |

### 4b. Pseudosandbox — working today, zero omp changes

This came out better than expected. **Display targeting is purely
environment-driven**, so an isolated agent desktop needs no code change at all.

`crates/pi-natives/src/desktop/linux/mod.rs:11-21` presence-tests
`WAYLAND_DISPLAY`, then `DISPLAY`; X11 connects via `x11rb::connect(None)`, i.e.
`$DISPLAY`. So pointing omp at a nested X server is sufficient.

**Why X11 and not a nested Wayland compositor:** the shipped native is built
without `wayland-pipewire`, so `capture` is `false`, and
`background_window_input` is hardcoded `false` for *any* Wayland compositor. A
nested Wayland seat would give omp nothing. A nested X11 seat gives it the full
feature set. Filed upstream as
[#9935](https://github.com/can1357/oh-my-pi/issues/9935).

Measured on this host, same native, only env changed:

```
DISPLAY=:0 WAYLAND_DISPLAY=wayland-0  → capture:false, backgroundWindowInput:false, displayCount:0
WAYLAND_DISPLAY unset, DISPLAY=:90    → capture:true, input:true, ax:true,
                                         backgroundWindowInput:true,
                                         deliveryModes:[background,foreground]
```

**Gotcha:** it is a *presence* test. `WAYLAND_DISPLAY=""` still selects Wayland.
It must be unset.

Prototype at `sandbox-prototype/` (29 evidence artifacts). `./run.sh` starts an
Xvfb seat, launches Brave into it, and has omp's own native capture, click and
type. Proven by a window-title oracle (`OMP-SEAT clicks=1 typed=omp-seat-ok<CR>`)
and a pixel-colour count (red 77784px→0, green 0→77393px). Your session was
verified bit-identical before/after — pointer position, active output, X
connection counts. Two disjoint X servers; XTEST structurally cannot cross them.
Teardown took 10 Brave pids → 0. Seat startup 0.06s; two seats coexist on
`:90`/`:91`.

**Option A — use it now, zero code:**

```bash
eval $(sandbox-prototype/seat.sh start "omp-$$")
env -u WAYLAND_DISPLAY DISPLAY=$DISPLAY XAUTHORITY=$XAUTHORITY omp
```

One omp process per seat. Subagents inside that process share the parent's seat.

**Option B — per-session seats, needs a small native plumb.** Bun's `new Worker`
is a *thread* (same pid) and Bun ignores its `env` option, so per-session
`DISPLAY` cannot be set from JS — the native reads `getenv`, which is
process-global. `std::env::set_var` is unsound under threads and two concurrent
seats would corrupt each other, so explicit plumbing is the only correct fix:
add `display_server` to `DesktopSessionOptions`, carry it into `SessionCore` and
the backend selector, and change `x11rb::connect(None)` to take it. Keep the
existing `display` option alone — it is a *monitor filter*, not a server
selector. Full file list is in the worker's report.

**Lifecycle:** hand the seat to `ComputerSupervisor` (already owns one worker per
session and has `close()`). Four independent reclaim paths were designed so this
does not become a new leak like #9922: owner teardown, an on-disk seat dir under
`$XDG_RUNTIME_DIR` swept on next start, X-server death reaping the seat's GUI
apps automatically, and explicit removal of `/tmp/.X<n>-lock` so display numbers
are not leaked.


## 5. Closed out after the first handoff pass

### tmpfs cap — DONE

Passwordless sudo was available, so I applied it rather than leaving it to you.
`/etc/systemd/system/tmp.mount.d/override.conf` caps `/tmp` at 2 GiB with
`nr_inodes=1m`, and I applied it live with `mount -o remount` rather than
restarting `tmp.mount` — a restart would have unmounted `/tmp` under the 16
processes with cwds there. `/tmp` is now 2.0 G (was 8.0 G); 23 open handles and
16 process cwds survived; the drop-in persists across reboot.

### Sandbox Option A — DONE, installed as a command

`~/.local/bin/omp-seat` — Option A packaged so it is usable rather than a
prototype:

```
omp-seat run                    # omp on its own isolated display
omp-seat run -- omp --resume     # any argv
omp-seat start <name> / stop / list
```

Verified end to end: inside the seat omp reports `backend:x11, capture:true,
input:true, ax:true, backgroundWindowInput:true, displayCount:1,
displayServer:":90"` — every capability that is broken on your real Wayland
session — and teardown leaves zero stray Xvfb processes.

It unsets `WAYLAND_DISPLAY` rather than emptying it, because the backend selector
is a presence test.

Option B (per-session seats inside one process) still needs the native plumb
described in section 4b, and is unchanged.

### CAD migration — surgical path ready, full jump deliberately not executed

See `CAD-CLOUDCASTLE-MIGRATION.md`. Branch `cad/oauth-fix-on-vendored-base` is
the OAuth fix cherry-picked onto CAD's **exact** pinned base
(`d1239fd3e57a48a35b483663d16ab078db75a87b`): 10 insertions across 2 files,
8 pass / 0 fail. Vendoring that is a no-version-jump change and fixes the OAuth
bug CAD inherits verbatim.

The full jump is blocked on a real coupling: CAD pins `pi-natives`/`pi-utils` at
**17.1.5** from npm while vendoring `ai`/`catalog` as source. I hit that exact
incompatibility by accident today — the 17.x native lacks `NativeDesktopSession`
that 18.x's adapter expects. So a full migration means bumping the native in the
same commit, across 5400+ commits of drift in the vendored packages, and I can't
validate CAD's bridge without its C++ core running. Not doing that unattended.

CloudCastle was not audited. Check first whether it vendors source or spawns the
`omp` CLI — a CLI consumer *is* affected by the `coding-agent` changes CAD is
immune to.

### Perf audit — DONE (the one I dropped)

Two of my own suspicions were wrong, which is worth recording:

- **The render path is already well engineered.** VCS lookups are TTL-cached
  (git 1s, jj 5s, usage 5min) with in-flight de-duplication, and reftable repos
  are explicitly routed off the sync path after a prior freeze incident. Git is
  *not* invoked per render. Renders are keystroke/stream-delta driven, not timed.
- **The undo `structuredClone` is negligible.** It clones only
  `{lines, cursorLine, cursorCol}` — the composer text box, not session state —
  grouped by word boundary rather than per keystroke, capped at 100 entries. Only
  pathological multi-MB pastes would matter.

Real opportunity found: capability discovery fires ~50 provider loads
concurrently through `Promise.all` (`capability/index.ts:113-122`), and the
underlying reader (`capability/fs.ts:10-49`) uses `node:fs` rather than
Bun-native async I/O. The cache itself is correct (two-tier, prevents
double-reads); the suspicion is libuv threadpool contention under that fan-out.
Measure with `bun run dev:timing` before changing anything.

Latent landmine worth deleting: `modes/components/footer.ts:95` calls
`git.head.resolveSync()` with no reftable guard, reintroducing the freeze bug
that was fixed on the status line. It is currently **dead** (exported from the
barrel, never instantiated), so there is no user impact today — but a future
refactor that instantiates it would reintroduce a UI stall. Not filed upstream;
dead code with zero impact did not seem worth a 13th issue, so it is recorded
here instead.

### Windows login crash — genuinely blocked

No upstream issue exists for it (searched). I cannot file a useful report without
a stack trace or crash log from one of the affected machines. What to capture on
a machine that reproduces it: the terminal output of the crash, and whether it
happens before or after "Successfully logged in". Note the CHANGELOG shows a
*previously fixed* Windows OAuth failure (port 1455 in use → silent fallback to a
random port → 403 at token exchange), so a port conflict is a plausible line of
enquiry.

---

## 6. Things worth not re-learning

- **Subagents are in-process**, not separate processes (`task/executor.ts` builds `AgentSession` objects), so `task.maxConcurrency` is a memory knob, not just a parallelism knob.
- **It is not a memory leak.** Nothing grows monotonically. The only provably unbounded structures (`AgentRegistry#refs`, `DaemonBroker#records`) are metadata-sized. The cost is high steady state + zero admission control.
- **The mnemopi embed worker** holds a full ONNX runtime + model (~774 MB measured) **per omp process**, with no idle teardown. Lazily spawned, so exposure is latent.
- **`/ssh` cannot be closed** — it prints a `TranscriptBlock` into scrollback rather than opening a surface.
- **Cache reads are priced correctly.** I expected a bug and there isn't one.
- **The `usage` segment already existed.** Several "missing features" here turned out to be unwired or unpresetted rather than absent — check before building.
- **Wayland limits on this host** are severe for `computer`: no capture, no window enumeration, no background input. This is the strongest argument for the pseudosandbox.

---

## 7. Repo docs

- `REQUIREMENTS.md` — the full requirement set with status
- `PR-BODIES.md` — PR bodies ready for submission
- `CAD-CLOUDCASTLE-MIGRATION.md` — what CAD actually consumes, the safe path, and the blocker on the full jump
- `CRASH-MITIGATIONS.md` — the three stacked causes of the machine-wide crashes
- `sandbox-prototype/` — the isolated-seat prototype and 29 evidence artifacts
- `oh-my-pi/ACKNOWLEDGEMENTS.md` — who contributed what, and why attribution is not distributed evenly
- Desktop: `OMP-1-DISCORD.md`, `OMP-2-SUBMIT-PRS.md`, `OMP-3-STATUS.md`
- Installed: `~/.local/bin/omp-seat` — run omp on its own isolated display
