# Hunter's Chudcode requirement set

Source: Hunter (Hunter-124), with ideas contributed by his brothers
(github.com/iamnotyobabydaddy, github.com/CharlesEdmonds). Captured verbatim in
intent, reorganized for execution. This is the authoritative statement of what
we are trying to achieve; workers should read this before designing anything.

Two consumer projects must eventually adopt these changes: `Hunter-124/CloudCastle`
and `Hunter-124/CAD` (both PRIVATE, must stay private). Both embed Chudcode sidecars.
CAD in particular also supports software-development workflows inside itself, so
UI/UX and agent-model changes need to be portable there.

## Guiding intent

- Chudcode is meant to be customizable, but the surface has grown far past useful.
  Fewer, better defaults; everything still reachable via config file or an
  explicit "advanced" mode. Removing a setting must never remove a capability.
- Transparency over cleverness: the user must be able to see what model is
  actually being used, what context an agent was given, and why.
- Failure should be graceful and local, never machine-wide.

## P0 — highest priority

1. **Prompt/draft preservation and undo/redo.** The single most-cited annoyance.
   Editor undo already exists but is bound to `ctrl+-`/`ctrl+_` (readline
   convention) so nobody finds it; there is no redo at all. Draft persistence
   exists but is a one-shot text-only snapshot written at teardown, and it drops
   pasted-image bytes, so a crash restores dangling markers.
2. **Chat history corruption / unresumable sessions.** Sessions break and cannot
   be continued. Suspected causes: incompatible tool-call results, and
   compaction (including "snapcompact") producing a format the session can no
   longer load. Compaction behavior is vague and under-observable; it needs
   auditable visuals so its functioning can be inspected.
3. **Memory exhaustion taking down the whole machine.** Opening several agent
   sessions crashes the host rather than failing one agent. Root-caused: see
   `CRASH-MITIGATIONS.md`. Not a leak — high steady state plus zero
   memory-aware admission control.

## P1 — UI/UX

4. **`/agents` vs `/models/roles` split.** Confusing and non-transparent. The
   user cannot tell which model actually serves a given agent, nor what extra
   role context is injected (the `/agents` screen hints at `embedded:*.md`,
   `prewalk`, `advisor` fields with no explanation). Merge/fuse the two concepts
   and make actual resolution visible.
5. **Status bar.** Too complicated; condensing loses information; symbols are
   unexplained; free horizontal space goes unused while useful state is omitted.
   Wanted: session title/subject, model, effort, current context + model limit
   (itself needing improvement), and agent count moved into the subagents view.
   Confirmed bug: `⚘ N agents` and `⚙ N` count the same population.
6. **`/tree` overhaul.** High-potential feature, currently weak. Wanted: a
   modern DAG view of agentic execution showing the main chat AND subagent
   sessions branching off it, their chains of thought and inter-agent
   communication drawn with connecting lines, plus relevant artifacts and the
   agent message board. Should support recovering from a broken session or
   picking up after a stall.
7. **Settings consolidation.** Deduplicate, remove, and automate. Hide
   macOS-only options on other platforms and implement the missing Linux/Windows
   equivalents. Better defaults, auto-derived where detectable.
8. **Mouse interaction in the TUI**, especially the settings and model-assignment
   pages, is very poor and needs to work properly.
9. **Attachment handling.** Pasted images render as an empty grey box with only
   dimensions instead of a real preview (the TUI *can* draw images — Kitty/iTerm2/
   sixel — it is simply not wired to prompt chips). Attachment numbering is wrong
   after delete-then-repaste. Documents and folders paste as raw plaintext paths
   instead of becoming attachments; an in-repo document converter (`markit`)
   already exists and could be reused.

## P2 — capability

10. **Auto-update.** An update notifier exists but never applies anything; a full
    `chudcode update` self-updater also already exists and is simply not wired to it.
    Wanted: opt-in automatic download/build+apply. Live mid-session hot-swap is
    not feasible (frozen module graph in the compiled binary, in-memory session
    state); stage-and-apply-on-next-launch is the realistic design.
11. **Model filter by release date.** Ability to hide models released before a
    given date in the model search/filter.
12. **Disabled-account pruning.** Dead provider accounts stay listed forever
    (observed: disabled 35–47 days). Should be pruned or re-validated
    automatically, distinguishing permanently-revoked from transient failures.
13. **Agent communication.** Hunter wants a built-in inter-agent comms method
    (message board / messenger model / "pseudo-Slack"). NOTE: `hub` already
    implements a mature point-to-point messenger — DM, broadcast, blocking wait,
    inbox, roster, reply threading, auto-wake and revival of parked agents. Do
    NOT rebuild it. Genuinely missing: durable/persisted messages readable after
    process exit, a topic/channel many-to-many subscribe abstraction, a shared
    mutable blackboard, structured request/response payloads (bodies are plain
    prose by explicit design), and cross-process messaging.
14. **OAuth login breakage.** The "Close Window" button on the auth success page
    does nothing (`window.close()` cannot close a tab the script did not open,
    and the OAuth redirect chain leaves >1 session-history entry). Separately,
    some Windows environments crash immediately on login — needs logs to
    diagnose, not yet root-caused.
15. **Isolated "pseudosandbox" for computer use.** HIGH priority. The `computer`
    tool drives the user's real desktop — same display, pointer and keyboard
    focus — so an agent and the user fight over one seat. Each agent should get
    its own display/keyboard/mouse so they can work in parallel. Explicitly NOT
    a security boundary: agents keep full access to files, application profiles
    and accounts. This is *seat* isolation, not permissions, and it should be
    high-performance (GPU acceleration desirable).
16. **Session cost accounting.** Costs "don't make sense" and there should be a
    coherent overall estimate. Adding model prices is hard; prices could be
    fetched automatically (the user suggested scraping with a small model) for
    providers that do not document them. Caution: a wrong scraped price silently
    corrupts every future total, so any fetch needs provenance and confirmation.
17. **Overlay dismissal.** `/models` and similar cannot be closed with one Esc.
    Note `/ssh` is not an overlay at all — it prints to scrollback, so it cannot
    be "closed"; and the multi-Esc behavior in `/models` is an intentional
    upstream contract (first Esc clears the search box) with a test asserting it.
    So this is a preference, shipped opt-in, not a bug fix.
18. **Remaining usage in the status bar.** Wanted prominently, plus an animated,
    visually intuitive usage/limit indicator. Root cause found: the `usage`
    segment already exists and renders, but is in **zero presets**, so it is
    unreachable unless named explicitly in `statusLine.rightSegments`.
19. **Model list de-noising.** Classifications are incoherent across providers.
    Cursor is worst: it bakes effort into the model id (`-low`/`-medium`/`-high`/
    `-xhigh`, optionally `-fast`) and those rows advertised `reasoning: false`.
    Also prune/hide models over a year old — which required adding a release-date
    field, since the catalog had none.

## Status as of 2026-08-27

### Landed in the fork (`Hunter-124/chudcode`)

| Branch | Item |
| --- | --- |
| `feat/editor-redo` | 1 (partial — redo only) |
| `fix/oauth-close-window` | 14 |
| `fix/status-bar-duplicate-count` | 5 (partial) |
| `fix/subagent-label-sanitize` | label markup leak |
| `feat/opt-in-auto-update` | 10 |
| `feat/catalog-cursor-effort-and-release-date` | 19 |
| `feat/opt-in-escape-dismiss` | 17 |

### Submitted upstream

PRs #9925 (redo), #9926 (oauth), #9927 (status bar duplicate).
Held for iamnotyobabydaddy / Charles: label-sanitize, auto-update (needs Discord
first), catalog, escape-dismiss.

### Issues filed (reported, not patched)

#9915 session-header data loss · #9916 memory admission control · #9917 pasted
image not un-attached · #9918 credential pruning · #9920 mouse routing · #9921
compaction observability · #9922 temp-file leaks · #9923 settings defects

### Host fixes applied

`/tmp` reclaimed (7.54 GB) and prevented from recurring; local status bar now
shows the usage segment. See `CRASH-MITIGATIONS.md`.

### Not started

4 (`/agents`+roles merge) · 6 (`/tree` DAG) · 7 (settings consolidation) ·
9 (attachment previews) · 15 (pseudosandbox — in progress) · 16 (cost — in
progress) · 1's draft-preservation half (in progress) · animated usage gauge ·
2 (history corruption — reported only)

## Constraints on how we contribute

Upstream (`Hunter-124/chudcode`) has binding rules in `CONTRIBUTING.md`:

- Major features (new subsystems, large UI changes, multi-package changes)
  require **Discord discussion before implementation**. A GitHub issue is
  explicitly not a substitute. This covers items 1, 4, 5, 6, 7, 10, 13.
- **Do not open an issue for work you intend to submit** — their `robochud` bot
  picks up actionable issues and may start the same work in parallel.
- Every PR body must contain at least one sentence written by the submitter in
  their own words, and the submitter must have reviewed the diff and exercised
  the behavior. This is a human gate by design.
- One logical change per PR; no drive-by refactors or unrelated cleanup.

Therefore: bug reports we are not implementing → issues. Everything we implement
→ fork first, PR prepared for Hunter to review and submit, with major items
raised on Discord beforehand.
