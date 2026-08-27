# Chudcode fork — handoff for Garrison

**Written for:** Simon Garrison ([@garrisonsimon](https://github.com/garrisonsimon)) and his coding agent.
**From:** the session of 2026-08-27 (Hunter orchestrating).
**Assume zero prior context.** Everything you need is here or linked from here.

You already have **write access** to `Hunter-124/chudcode`.

---

## 0. Read this first — the five things that will waste your time

1. **`git fetch` before you cite any line number.** The local checkout was
   **5412 commits behind** upstream and I filed 8 issues against a 5-week-stale
   tree before noticing. Two of them were already fixed upstream and I had to
   close them publicly. Current upstream main is `d17c270090` (v18.0.7,
   2026-08-26). Verify with `git log -1 origin/main` **after** fetching.
2. **7 of the 9 fork branches are still based on the July tree.** They will
   conflict on submission. See §3 — this is the top priority task.
3. **Upstream has binding contribution rules.** Read
   `oh-my-pi/CONTRIBUTING.md` before touching a PR. Summary in §2. Ignoring them
   gets PRs closed on sight, and this fork's whole purpose is landing work
   upstream in a 27k-star repo.
4. **`packages/stats/src/db.ts` is Hunter's uncommitted work.** Do not commit,
   revert, stash, or format it. It has been dirty the entire time on purpose.
5. **Several "missing features" turned out to already exist**, just unwired.
   Check before building. Examples: editor undo existed (bound to `ctrl+-`, which
   nobody discovers); the `usage` status-bar segment existed but was in zero
   presets; `chudcode update` implements a full self-updater the notifier never calls;
   `hub` already implements agent messaging. Grep first, build second.

---

## 1. Where things are

| Path | What |
| --- | --- |
| `~/Repositories/omp-inspection/oh-my-pi` | The working checkout. `origin` = upstream, `fork` = `Hunter-124/chudcode` |
| `~/Repositories/omp-inspection/HANDOFF.md` | The detailed record — every request, its status, and why |
| `~/Repositories/omp-inspection/REQUIREMENTS.md` | The full requirement set with priorities |
| `~/Repositories/omp-inspection/PR-BODIES.md` | PR bodies ready for submission |
| `~/Repositories/omp-inspection/CAD-CLOUDCASTLE-MIGRATION.md` | How CAD consumes Chudcode, the safe path, the blocker |
| `~/Repositories/omp-inspection/CRASH-MITIGATIONS.md` | Why the machine was dying and what was fixed |
| `~/Repositories/omp-inspection/sandbox-prototype/` | Isolated-display prototype + 29 evidence artifacts |
| `~/.local/bin/omp-seat` | Working command: run Chudcode on its own isolated display |
| `~/Repositories/CAD` | Hunter's **private** CAD project. Vendors part of omp. Keep it private |

Build/test commands (from the repo root):

```bash
bun run check        # the typecheck + lint gate
bun test packages/<pkg>/test/<file>.test.ts
bunx biome check --write <files>     # formatter
bun run build:native                # Rust natives — SLOW, needs a process manager not a bash timeout
```

---

## 2. Upstream rules — non-negotiable

From `oh-my-pi/CONTRIBUTING.md`:

- **Major features need a Discord discussion *before* implementation.** New
  subsystems, large UI changes, multi-package changes. A GitHub issue is
  explicitly **not** a substitute. Discord: https://discord.gg/4NMW9cdXZa
- **Do not open an issue for work you intend to submit.** Their `robomp` bot
  picks up actionable issues and may start the same work in parallel.
- **Every PR body must contain at least one sentence written by the submitter, in
  their own words**, and the submitter must have reviewed the diff and exercised
  the behavior. `bun check` passing is explicitly *not* sufficient verification.
- One logical change per PR. No drive-by refactors.
- AI-assisted work is allowed; agents publishing autonomously is not.

**Standing decision on attribution, so you're not asked twice:** commit
co-authorship in this fork reflects who actually contributed to that specific
change. It is not distributed to pad contribution graphs, and it is not
randomized to look organic. Rationale is in `oh-my-pi/ACKNOWLEDGEMENTS.md` — it's
self-interested, not moralistic: a history crediting people who can't answer a
question about the code is trivially detectable and costs exactly the credibility
this effort is trying to build. If you contribute, you get credited on what you
did.

---

## 3. PRIORITY 1 — rebase the stale branches

Only `feat/editor-redo` and `fix/status-bar-duplicate-count` are on current main.
The rest are on `f833810d0e` (July 23) and will conflict.

| Branch | Base | State |
| --- | --- | --- |
| `feat/editor-redo` | **current** | PR [#9925](https://github.com/can1357/oh-my-pi/pull/9925), MERGEABLE |
| `fix/status-bar-duplicate-count` | **current** | PR [#9927](https://github.com/can1357/oh-my-pi/pull/9927), MERGEABLE |
| `fix/oauth-close-window` | stale | PR [#9926](https://github.com/can1357/oh-my-pi/pull/9926), MERGEABLE by luck (the file didn't change upstream) |
| `fix/subagent-label-sanitize` | stale | not submitted |
| `feat/opt-in-auto-update` | stale | not submitted, **needs Discord first** |
| `feat/catalog-cursor-effort-and-release-date` | stale | not submitted |
| `feat/opt-in-escape-dismiss` | stale | not submitted |
| `feat/cross-platform-antisleep` | stale | not submitted |
| `fix/pending-image-reconcile` | stale | integration branch — draft autosave + acknowledgements live here |
| `cad/oauth-fix-on-vendored-base` | CAD's pin | intentionally NOT rebased — see §6 |

**How to rebase safely** (learned the hard way):

```bash
# Use a scratch worktree — never disturb the main checkout (Hunter's db.ts).
git worktree add --detach ~/.cache/omp-rebase2 origin/main
cd ~/.cache/omp-rebase2
bun install                 # deps drifted over 5 weeks; the old node_modules will NOT work
bun run build:native        # required, and the 17.x native is ABI-incompatible with 18.x
git checkout <branch> && git rebase origin/main
```

Two conflicts you should expect, both already solved once on `feat/editor-redo`:

- `packages/tui/src/keybindings.ts` — upstream added `tui.editor.spellingSuggestions`
  next to our `tui.editor.redo`. Purely additive: keep both.
- `packages/tui/src/components/editor.ts` — **upstream changed the dispatch API**
  from `kb.matches(data, id)` to `kb.matchesCanonical(canonical, id)`. Don't paste
  the old call; match the `undo` branch directly above it.

For `fix/status-bar-duplicate-count` the region was rewritten upstream, so the
patch had to be re-applied by hand rather than rebased. Expect the same for
others touching heavily-edited files.

**Always re-run the tests on the new base before force-pushing.** `feat/editor-redo`
was verified at 1380 pass / 0 fail on real 18.0.7 before its `--force-with-lease`.

---

## 4. What's done and verified

Each of these was exercised, not just compiled.

| Change | Branch | Evidence |
| --- | --- | --- |
| Editor **redo** (undo existed on `ctrl+-`; no redo at all) | `feat/editor-redo` | 1380 TUI tests pass on 18.0.7. Bound to `alt+-`, deliberately **not** `ctrl+shift+z` — legacy terminals collapse it to `ctrl+z`, which `app.suspend` owns |
| OAuth "Close Window" dead button | `fix/oauth-close-window` | 8 pass. `window.close()` can't close a tab the script didn't open, and the redirect chain leaves >1 history entry |
| Status bar counting subagents twice | `fix/status-bar-duplicate-count` | Every task spawn registers both an `AgentRegistry` ref and an `AsyncJobManager` job |
| `</title>` leaking into subagent labels | `fix/subagent-label-sanitize` | 9 pass, incl. `Map<K,V>` and `A -> B` surviving byte-identical |
| Opt-in auto-update | `feat/opt-in-auto-update` | 6 pass. `startup.autoUpdate` off/notify/auto + 6h throttle + SHA-256 verify, fail-closed |
| Cursor effort normalization + `releaseDate` | `feat/catalog-cursor-effort-and-release-date` | 478 catalog tests pass |
| Single-Esc overlay dismissal (**opt-in**) | `feat/opt-in-escape-dismiss` | Opt-in because upstream has a **test asserting** the two-step behavior — flipping the default would break their contract |
| Prompt draft autosave | `fix/pending-image-reconcile` | Proven by actually `SIGKILL`ing a child process and resuming the text |
| Anti-sleep for Linux/Windows | `feat/cross-platform-antisleep` | Proven live: `chudcode … idle … block` in `systemd-inhibit --list` while held, absent after release |

Host fixes applied directly (not code): `/tmp` reclaimed 7.54 GB and capped at
2 GiB; disk-backed `TMPDIR` + weekly prune installed; `usage` segment added to
Hunter's status bar config.

### Upstream issues open

9916 memory · 9917 image un-attach · 9918 credentials · 9920 mouse · 9922 temp
leaks · 9923 settings · 9928 settings sync · 9929 usage segment · 9930 cost ·
9931 attachments · 9932 agents/roles · 9934 Cursor · 9935 Wayland

9915 and 9921 were closed by me as stale — see §0.1.

---

## 5. The direction, and what's actually important

Ranked by value, with reasoning rather than vibes.

### Tier 1 — finish what's started
1. **Rebase the 7 stale branches** (§3). Nothing else can land until this is done.
2. **Michael submits the ready PRs.** Bodies are in `PR-BODIES.md`; each needs
   one sentence in his own words. Do not submit them for him.
3. **Hunter presses Enter on the staged Discord message** (`#💡-feature-requests`,
   already composed, 1729 chars). Needed before `feat/opt-in-auto-update` can be
   proposed.

### Tier 2 — highest user value, buildable now
4. **Isolated display seats (Option B).** Option A already works
   (`omp-seat run`), but subagents inside one Chudcode process share the parent's seat.
   Option B needs a small native plumb: add `display_server` to
   `DesktopSessionOptions`, carry it into `SessionCore` and the backend selector,
   and change `x11rb::connect(None)` to take it. **Do not** use
   `std::env::set_var` — it's process-global and unsound under threads, and Bun
   `new Worker` is a *thread*, not a process. Full file list in `HANDOFF.md` §4b.
5. **Cost accounting honesty** (issue 9930). Missing rates become `0` via `?? 0`
   and the Hub counts a finite `0` as "measured", so the headline understates with
   no way to tell. Fix: represent unknown pricing, then surface "N of M priced".
   Cache reads are *already* priced correctly — don't chase that.
6. **Settings consolidation** (issue 9923). The mechanism already exists:
   `condition` + the `CONDITIONS` map, enforced at `settings-selector.ts:799-802`.
   An Advanced tier is **one boolean + one CONDITIONS entry, no renderer change**.
   ~115 of ~300 keys are already config-file-only.

### Tier 3 — high value, needs Discord first
7. **`/agents` + `/models/roles` merge** (issue 9932). Hunter's #2 complaint.
   Related open upstream issue #6514 suggests the precedence is genuinely subtle.
8. **`/tree` as an execution DAG.** Most lineage data already exists (session
   `parentId` tree, `SessionHeader.parentSession`, `AgentRef.parentId`,
   `history://`, `artifact://`). **Two real blockers:** nothing in the TUI draws
   edges between nodes, and cross-agent chat is TUI-only and TTL-expiring, so a
   restart-durable DAG needs the message board persisted first.
9. **Agent comms.** `hub` already does DM, broadcast, blocking wait, inbox,
   roster, reply threading, auto-wake of parked agents — **do not rebuild it**.
   Genuinely missing: durable messages readable after exit, topic/channel
   subscribe, a shared mutable blackboard, structured payloads, cross-process.

### Tier 4 — known but deliberately parked
- **Real attachment previews** (9931). The TUI *can* draw images and does for
  assistant messages. Blocker: `renderReference` returns a **string** and
  Markdown renders to string lines, so an `Image` Component can't embed there —
  needs that render path restructured.
- **Documents/folders as attachments** (9931). The `markit` converter already
  exists and is used by `read`; the paste path just needs a third category.
- **Animated usage gauge.** No repaint driver in the status line. Must be owned by
  interactive-mode's lifecycle and repaint the editor — **never** a timer inside
  segment render.
- **Windows login crash.** Genuinely blocked: needs a stack trace from an
  affected machine. No upstream issue exists. A previously-fixed Windows OAuth
  bug (port 1455 in use → silent fallback → 403) is a plausible lead.
- **Perf.** The render path is already well engineered (TTL caches, in-flight
  dedup). Real lead: ~50 concurrent capability-provider loads over `node:fs`
  rather than Bun-native I/O. Measure with `bun run dev:timing` first. The undo
  `structuredClone` is **not** a problem — it clones only the composer text box.

---

## 6. CAD — read before touching it

CAD is **private**. Keep it that way.

CAD does not run the `chudcode` CLI. It vendors `ai`, `catalog`, `utils`, `wire`,
`mnemopi`, `snapcompact` at a pinned SHA and talks to them over a bun sidecar.
It deliberately does **not** vendor `pi-coding-agent` or `pi-tui`, so most of our
work cannot affect it. Only the OAuth fix (`ai`) and Cursor classification
(`catalog`) are relevant.

**Safe adoption, ready now** — `cad/oauth-fix-on-vendored-base`
(`91a64a594c9e76bbda8990a50da8d3425cb564ad`) is the OAuth fix on CAD's *exact*
pinned base. 10 insertions, 8 pass / 0 fail, no version jump:

```bash
cd ~/Repositories/CAD
python3 scripts/vendor_omp.py \
  --from https://github.com/Hunter-124/oh-my-pi.git \
  --sha 91a64a594c9e76bbda8990a50da8d3425cb564ad \
  --packages ai catalog utils wire mnemopi snapcompact
python3 scripts/vendor_omp.py --verify
```

Expect a diff in `oauth.html` and its test **only**. Anything else means the base
moved — stop.

**Do not attempt the full version jump without Hunter present.** CAD pins
`pi-natives`/`pi-utils` at **17.1.5** from npm while vendoring the rest as
source. I hit that exact incompatibility by accident: the 17.x native lacks
`NativeDesktopSession` that 18.x's adapter expects. A full jump means bumping the
native in the same commit across 5400+ commits of drift, and it can't be
validated without CAD's C++ core running.

**CloudCastle was never audited.** Before migrating it, check whether it vendors
source or spawns the `chudcode` CLI — a CLI consumer *is* affected by all the
`coding-agent` changes CAD is immune to.

---

## 7. Traps discovered, so you don't rediscover them

- **Wayland cripples the `computer` tool on this host.** `capture:false`,
  `backgroundWindowInput:false`, one enumerable window. The shipped native is
  built without `wayland-pipewire` and `background_window_input` is hardcoded
  `false` for any compositor (issue 9935). A nested **X11** seat restores
  everything; a nested Wayland seat gives you nothing.
- **Backend selection is a *presence* test.** `WAYLAND_DISPLAY=""` still selects
  Wayland. It must be **unset**.
- **Discord rejects synthetic key events**, and CDP-injected keys didn't work
  either. Automating a Discord post on this host is not currently possible.
- **Some upstream tests encode the opposite of what you might "fix".** I built a
  correct-looking fix for the pasted-image bug and it broke ~20 tests, because
  they attach images with no marker in the text — meaning "pending images are
  marker-backed" is *not* an upstream invariant. Filed as 9917 instead of forcing
  it. If a fix requires rewriting their tests, stop and ask.
- **Test doubles can lack methods.** The image-paste tests use a fake editor with
  no `getText()`, so anything calling it throws and silently falls back.
- **`bun run build:native` outlives a bash timeout.** Use a process manager.
- **The 17.x and 18.x natives are ABI-incompatible.** Symlinking prebuilt
  artifacts across versions fails with `WeakMap keys must be objects`.

---

## 8. If you're an agent reading this

Do this in order:

1. `cd ~/Repositories/omp-inspection/oh-my-pi && git fetch origin main` — then
   confirm `origin/main` is newer than `d17c270090` or not.
2. Read `oh-my-pi/CONTRIBUTING.md` and `oh-my-pi/AGENTS.md` in full. AGENTS.md
   has hard style rules (Bun over Node, no `any`, no `ReturnType<>`, no dynamic
   `import()`, `#private` fields, prompts live in `.md` files).
3. Read `~/Repositories/omp-inspection/HANDOFF.md` for the per-item detail.
4. Start on §3 (rebasing). It unblocks everything else.
5. Verify by exercising behavior, not by compiling. Every claim in §4 has a
   number attached because unverified claims were treated as not done.
6. When a premise you were given turns out to be false, **stop and report it**
   rather than working around it. That happened repeatedly here and was correct
   every time: cache reads weren't mispriced, the undo clone wasn't expensive, the
   lost-update hazard was already engineered against, the default was already on.
   Reporting "your premise is wrong" was more valuable than an implementation.
