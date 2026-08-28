# Mikey — PR submission checklist

Prepared for you, not submitted for you. `ONBOARDING.md` is explicit: "Michael
submits the ready PRs... Do not submit them for him." Nothing here has been
sent. No `gh pr create` was run, nothing was pushed, and no `> YOUR SENTENCE
HERE` line was filled in while preparing this doc.

Everything below was re-verified against live `git` and the real GitHub API on
2026-08-27, not copied from the other docs. Where the other docs turned out to
be stale or wrong, it's flagged explicitly — see §2.

---

## 0. Upstream status right now — READ THIS FIRST

`HANDOFF.md` (lines 33–37) and `REQUIREMENTS.md` (line 137) say #9925, #9926,
#9927 are done deals ("Ready, MERGEABLE"). That undersells what's actually
happening. Verified via `pr://can1357/oh-my-pi/9925|9926|9927` just now:

| PR | Branch | State | Reality |
| --- | --- | --- | --- |
| [#9925](https://github.com/can1357/oh-my-pi/pull/9925) | `feat/editor-redo` | **OPEN**, merge_state `UNSTABLE` | Already submitted by **Hunter-124**, not you. 3 review rounds (roboomp + Codex bot) raised 4 blocking/should-fix items (unparseable legacy `alt+-`, redo lost on no-op edits, `Input.setValue()` resurrecting old text, changelog placement). Hunter pushed fixes for all of them across 3 follow-up commits; current head `5f4448cfbc` matches `origin/feat/editor-redo` exactly. |
| [#9926](https://github.com/can1357/oh-my-pi/pull/9926) | `fix/oauth-close-window` | **OPEN**, merge_state `UNSTABLE` | Same pattern: a bad `linkedom` catalog dependency and a source-text-only test were flagged and fixed (switched to `@oh-my-pi/pi-utils/dom`, added a real behavioral test). Head `8c3e73df50` matches origin. |
| [#9927](https://github.com/can1357/oh-my-pi/pull/9927) | `fix/status-bar-duplicate-count` | **OPEN**, merge_state `UNSTABLE` | The original bash-only filter hid running `eval` jobs and queued task jobs; both were fixed by tracking running-subagent ids instead of a type allowlist. Head `1eb520de55` matches origin. |

**Do not open a PR for any of these three branches. Do not push to them.**
They are Hunter-124's to manage upstream — `HANDOFF.md` line 39 itself only
holds back the other five branches for you and Charles. If you want to help,
the useful thing is reading the review threads so you understand the kind of
feedback this repo gives (see §4 below — the pattern repeats).

I also searched every open PR authored by `Hunter-124` on `can1357/oh-my-pi`
(6 total: #9925, #9926, #9927, #9983, #9997, #9998) and every PR whose title
mentions `subagent-label-sanitize` or `opt-in-auto-update`. **Neither of your
two remaining branches has been submitted anywhere.** That part of the docs is
accurate.

---

## 1. There is no points system here — be factual about that

There is no leaderboard, points, or bounty concept anywhere in this project —
verified: neither `chudcode` nor `CloudCastle` has any such mechanism, and
`ONBOARDING.md`'s "Standing decision on attribution" section states plainly
that co-authorship reflects who actually contributed and is deliberately
**not** padded or randomized to look organic, because a history crediting
people who can't answer a question about the code is trivially detectable and
costs credibility. Upstream itself runs on a maintainer "vouch" trust gate
(currently suspended as a trial, per `CONTRIBUTING.md`'s note — PRs are open
to everyone for now, but the vouch requirement may return). None of that is a
game to win. The two PRs below are worth submitting because you can sit in the
review thread and defend every line, the same way Hunter did three times over
in #9925/#9926/#9927 — not because your name ends up on a counter anywhere.

---

## 2. Corrections — where the prep docs were stale or wrong

- **`HANDOFF.md:35-37` / `REQUIREMENTS.md:137`** — "Ready, MERGEABLE" for
  #9925/#9926/#9927 reads as "done, nothing left to do." The real state is
  three *open* PRs that already went through multiple rounds of blocking
  review, all now addressed by Hunter, `merge_state: UNSTABLE` (GitHub's
  "mergeable but a required check is unresolved" state, not "blocked"). Not
  false, just materially incomplete — flagged in §0.
- **`PR-BODIES.md`** treats all five branches uniformly as "pushed and
  verified" and ready to submit, with an ordering strategy ("send
  `feat/editor-redo` and `fix/oauth-close-window` first... wait for a
  reaction") that is now moot — those two, plus `fix/status-bar-duplicate-count`,
  are already sent. It also never mentions branch staleness, which matters:
  see next point.
- **Confirmed via `git merge-base`**: both of your remaining branches
  (`fix/subagent-label-sanitize`, `feat/opt-in-auto-update`) share a merge-base
  of `f833810d0e` with `main` — the July 23 tree — and are **5,628 commits
  behind** current `main` (`651f99dbdf`, 2026-08-27). `ONBOARDING.md §3` says
  this correctly ("7 of 9 fork branches... will conflict on submission");
  `PR-BODIES.md` doesn't mention it at all. Practically: the *logical* diff
  (below, via `git diff --stat main...<branch>`) is small and clean, but a
  live PR against upstream `main` may show conflicts or an `UNSTABLE`/`DIRTY`
  merge state until it's rebased, exactly like `fix/oauth-close-window` was
  ("MERGEABLE by luck" — the file it touched hadn't changed upstream) and
  exactly like `fix/status-bar-duplicate-count` needed hand-reapplication for.
  **Nobody has rebased these two branches.** That's a real pre-submission
  step, not busywork — see §4.
- **Neither remaining branch touches a `CHANGELOG.md`** (`git diff --name-only
  main...<branch> | grep -i changelog` → empty for both). Every one of
  Hunter's three submitted PRs got a review comment for a missing or
  misplaced `[Unreleased]` changelog entry (see the linked review comments in
  §0). Expect the same comment on yours unless you add one first. This is a
  real, evidence-based prediction, not a guess — it happened three times in a
  row on sibling PRs today.
- Minor: the task brief that generated this checklist cited
  `ONBOARDING.md:44-49` for the "no padded contribution graphs" claim; in the
  actual file that content is at **lines 74–81** ("Standing decision on
  attribution"). Lines 44–49 are an unrelated path table. Flagging so nobody
  goes looking in the wrong place.

---

## 3. Final submission plan

Only **two** branches genuinely remain unsubmitted:

1. `fix/subagent-label-sanitize` — narrow bug fix, no Discord needed, small
   diff (4 files, +157/−8). Straightforward per `CONTRIBUTING.md`'s "small
   changes" tier.
2. `feat/opt-in-auto-update` — touches startup and can install software.
   `PR-BODIES.md` line 21-24 correctly flags this as needing **Discord
   discussion before the PR**, per `CONTRIBUTING.md`'s "major changes" rule
   (new dependency-adjacent behavior + security-sensitive: SHA-256
   verification of a downloaded binary). Do not open this PR until that
   thread exists and you've raised the caveat below in it.

Order: rebase-check and submit **#1 first** (it's the smaller, less
contentious change and doesn't need to wait on anyone). Post the Discord
thread for **#2** whenever it's convenient — it doesn't block #1 — then open
that PR only after the discussion has happened, not before.

Do not batch them; `PR-BODIES.md`'s "don't submit all five at once, wait for
a reaction" advice is still sound for whatever you do send, even though the
batch is down to two.

---

## 4. Before you touch either branch

Run this once, from a scratch worktree (never your main checkout —
`ONBOARDING.md §3` warns `packages/stats/src/db.ts` is Hunter's uncommitted
work; don't disturb it):

```bash
git worktree add --detach ~/.cache/omp-rebase-mikey origin/main
cd ~/.cache/omp-rebase-mikey
bun install
bun run build:native   # slow — use a process manager, not a bash timeout
git checkout fix/subagent-label-sanitize && git rebase origin/main
# resolve conflicts if any, re-run the branch's test file, force-with-lease
git checkout feat/opt-in-auto-update && git rebase origin/main
# same
```

Add a one-line `## [Unreleased]` entry to `packages/coding-agent/CHANGELOG.md`
for each branch before opening its PR (convention from `AGENTS.md:294-305`:
`### Fixed` for the label fix, `### Added` for auto-update; one line,
user-facing, e.g. "Fixed `</title>` and similar markup leaking into
auto-generated subagent labels."). This isn't optional polish — it's the
single most common review comment on this repo right now.

---

## 5. `fix/subagent-label-sanitize`

- **Branch:** `fix/subagent-label-sanitize`
- **Head SHA (unrebased):** `b4e528a3ca` — "fix(coding-agent): strip
  model-emitted title markup from subagent labels"
- **Diffstat vs `main`:** 4 files changed, 157 insertions(+), 8 deletions(-)
  - `packages/coding-agent/src/modes/components/agent-hub.ts` (+/-)
  - `packages/coding-agent/src/task/label.ts` (+/-)
  - `packages/coding-agent/src/utils/title-generator.ts` (+/-)
  - `packages/coding-agent/test/task-label-sanitization.test.ts` (new, +130)
- **Title:** `fix(coding-agent): strip model-emitted title markup from subagent labels`

**Command (after rebase, from your branch checkout):**

```bash
gh pr create --repo can1357/oh-my-pi \
  --head Hunter-124:fix/subagent-label-sanitize --base main \
  --title "fix(coding-agent): strip model-emitted title markup from subagent labels" \
  --body-file body-subagent-label-sanitize.md
```

**Body — save verbatim as `body-subagent-label-sanitize.md`. The
`> YOUR SENTENCE HERE` line is the ONLY line in this file you are allowed to
write. It must be one honest sentence in your own words, written after you've
actually read the diff and run the exercise below. Leave it exactly as-is
until then:**

```
> YOUR SENTENCE HERE
>
> An auto-generated subagent label rendered in the subagent list as
> `Map TUI editor for undo/redo feature</title>` — a literal unstripped tag.
> Labels come from a model, so stray or partial markup is expected input rather
> than an anomaly.
>
> Title extraction already stripped exact `<title>` tags; the gaps were variants
> carrying whitespace or attributes, differing case, and truncated fragments.
> This hardens extraction and adds a sanitizer at both the label-commit boundary
> and the hub render boundary, so a future regression in the generator cannot
> reach the screen.
>
> Matching requires tag syntax rather than bare angle brackets, so legitimate
> labels like `Map<K,V>` and `migrate A -> B` survive byte-identical; both are
> covered by tests to stop a future over-eager fix from regressing them.
>
> Tests: 9 pass, 0 fail.
```

**Hands-on exercise (mandatory — `bun check` passing is not proof, per
`CONTRIBUTING.md`):**

- [ ] Run `chudcode`, spawn at least one subagent via the task tool whose
      auto-generated title could plausibly contain leftover markup.
- [ ] Open the subagent list / hub view and confirm no label shows a stray
      unstripped tag like `</title>`.
- [ ] Confirm labels containing legitimate `<`/`>` text — try something like
      `Map<K,V>` or `migrate A -> B` as a task description — still render
      byte-identical, not stripped or mangled.
- [ ] Run the touched test file narrowly:
      `bun test packages/coding-agent/test/task-label-sanitization.test.ts`
      and confirm it passes on your machine, on the *rebased* branch.

**Be ready to answer:**

1. Your diff doesn't touch `CHANGELOG.md`. All three sibling PRs today got a
   review comment for exactly that. Add the `[Unreleased]` entry before you
   submit, or have an answer ready for why you didn't.
2. What's the actual matching rule that lets `Map<K,V>` and `A -> B` survive
   untouched while `</title>`, whitespace/attribute variants, differing case,
   and truncated fragments all get stripped? Be able to state it precisely,
   not just "it requires tag syntax."

---

## 6. `feat/opt-in-auto-update` — Discord first

- **Branch:** `feat/opt-in-auto-update`
- **Head SHA (unrebased):** `94c56c4898` — "feat(coding-agent): opt-in
  automatic update staging"
- **Diffstat vs `main`:** 5 files changed, 360 insertions(+), 74 deletions(-)
  - `packages/coding-agent/src/cli/update-cli.ts` (+210/… largest file)
  - `packages/coding-agent/src/config/settings-schema.ts` (+17)
  - `packages/coding-agent/src/main.ts` (+118/…)
  - `packages/coding-agent/src/modes/utils/ui-helpers.ts` (+16/…)
  - `packages/coding-agent/test/startup-auto-update.test.ts` (new, +73)
- **Title:** `feat(coding-agent): opt-in automatic update staging`

**Discord gate — do this BEFORE opening the PR:** raise it in
https://discord.gg/4NMW9cdXZa per `CONTRIBUTING.md`'s "major changes" rule
(startup behavior change + can install software = broad/behavioral, and it's
multi-file). Disclose the caveat `PR-BODIES.md` already names: this adds
SHA-256 verification against GitHub's published asset digests for raw-binary
updates and fails closed, because auto-applying an unverified binary would be
worse than requiring a manual `chudcode update`; package-manager installs
delegate integrity to the package manager; source/`bun link` checkouts are
excluded entirely. **Do not open this PR until that thread has happened.**

**Command (after the Discord discussion AND after rebasing):**

```bash
gh pr create --repo can1357/oh-my-pi \
  --head Hunter-124:feat/opt-in-auto-update --base main \
  --title "feat(coding-agent): opt-in automatic update staging" \
  --body-file body-opt-in-auto-update.md
```

**Body — save verbatim as `body-opt-in-auto-update.md`. Same rule: the
`> YOUR SENTENCE HERE` line is the only line you write, and only after you've
read the diff and run the exercise:**

```
> YOUR SENTENCE HERE
>
> Chudcode notified about new versions but never applied them, while a complete
> self-updater already existed behind `chudcode update` and was simply never wired to
> the notifier. The startup check also re-hit the npm registry on every launch
> with no caching.
>
> Adds `startup.autoUpdate` (`off|notify|auto`, default `notify`), mirroring the
> existing `marketplace.autoUpdate` enum precedent, and persists a six-hour
> throttle for the version check. `notify` is byte-for-byte today's behavior, so
> the default is unchanged. `auto` reuses the existing update machinery rather
> than duplicating it.
>
> Updates apply on **next launch**, never mid-session — the running process keeps
> its loaded version. Live hot-swap was considered and rejected: the compiled
> binary has a frozen module graph and session state is in-memory.
>
> Raw-binary updates verify the release asset's SHA-256 against GitHub's published
> digest and fail closed. Source and `bun link` checkouts are excluded from
> `auto`, since those are the user's own git tree.
>
> Tests: 6 pass, 0 fail, covering the mode decision including
> `startup.checkUpdate === false` precedence, and throttle suppression.
```

**Hands-on exercise (mandatory):**

- [ ] Set `startup.autoUpdate: notify` in config, launch Chudcode, confirm
      behavior is byte-for-byte what it does today (notify only, no apply).
- [ ] Set `startup.autoUpdate: off`, launch Chudcode, confirm the update
      check is skipped entirely (no registry hit at all).
- [ ] Set `startup.autoUpdate: auto`, launch Chudcode, confirm it stages an
      update and reports it will apply on the *next* launch, not mid-session.
- [ ] Launch Chudcode a second time inside the 6-hour throttle window and
      confirm it does not re-hit the npm registry.
- [ ] Run the touched test file narrowly:
      `bun test packages/coding-agent/test/startup-auto-update.test.ts` and
      confirm it passes on the *rebased* branch.
- [ ] Post the Discord thread and get at least one reaction/response before
      opening the PR.

**Be ready to answer:**

1. Same CHANGELOG gap as the other branch — add the `[Unreleased]` entry
   first.
2. What does the user actually see when SHA-256 verification fails on a
   raw-binary update — a visible error, or a silent fall-back to notify-only?
   "Fails closed" needs a concrete, observable answer.
3. This branch is 5,628 commits behind current `main` (July 23 base) and has
   never been rebased, unlike the three sibling branches that all needed a
   real rebase (or hand-reapplication) before they'd merge cleanly. Have you
   actually rebased and retested this, or only diffed it against an old base?
4. How does the code reliably detect "this is a source checkout / `bun link`"
   to exclude it from `auto`, and what happens if that detection is wrong?

---

## 7. Confirmation

No `gh pr create`, no `git push`, no branch created or rebased, and no
`> YOUR SENTENCE HERE` line filled in while preparing this document. Every
branch/commit/diffstat claim above came from local read-only `git`
(`branch -a --list`, `ls-remote --heads origin`, `log --oneline`,
`diff --stat`, `merge-base --is-ancestor`) run against this checkout on
2026-08-27, and every PR-state claim came from a live GitHub lookup
(`pr://can1357/oh-my-pi/9925`, `/9926`, `/9927`, plus `search_prs` for
`author:Hunter-124` and for the two remaining branch names) run the same day.
