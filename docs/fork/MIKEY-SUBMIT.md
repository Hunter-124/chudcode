# Mikey — PR submission checklist

Prepared for you, not submitted for you. `ONBOARDING.md` is explicit: "Michael
submits the ready PRs... Do not submit them for him." No `gh pr create` was run,
no PR or issue was touched, and no `> YOUR SENTENCE HERE` line was filled in.

Both branches **have** been rebased onto current upstream main and force-pushed
to the fork's feature branches (never to `main`), so they are ready to submit as
they stand — see §4. Only your sentence and a hands-on exercise remain (§8).

Everything below was re-verified against live `git` and the real GitHub API on
2026-08-27, not copied from the other docs. Where the other docs turned out to
be stale or wrong, it's flagged explicitly — see §2.

> **Update, later the same evening:** four more branches were replayed onto the
> same `upstream/main` and are now equally ready, and the co-author trailer on
> every branch was corrected so Michael's credit actually resolves on GitHub.
> That moved the head SHA of both branches below. Current state, rationale, and
> the exact conflicts resolved are in `HANDOFF-TO-HUNTER.md`; the SHAs in this
> file have been updated to match. §3's "only two branches remain" is now
> "six branches are ready".

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

**Six** branches are ready and unsubmitted. Each is exactly 1 commit ahead of
`upstream/main` @ `caefa61023` and 0 behind:

| # | Branch | Head | Gate |
| --- | --- | --- | --- |
| 1 | `fix/subagent-label-sanitize` | `b8fb671f27` | none — send this one first |
| 2 | `feat/opt-in-escape-dismiss` | `7d651adb06` | none |
| 3 | `feat/catalog-cursor-effort` | `a00fcca02d` | none; disclose the `models.json` regen gap |
| 4 | `feat/catalog-release-date` | `0292b2af59` | none |
| 5 | `feat/cross-platform-antisleep` | `36074ff860` | none; Windows path proven by FFI round-trip, not `powercfg` |
| 6 | `feat/opt-in-auto-update` | `78f9165f02` | **discussion [#10015](https://github.com/can1357/oh-my-pi/discussions/10015) has no reply yet** |

#3 and #4 are the July branch `feat/catalog-cursor-effort-and-release-date`
split in two, because its two concerns touch disjoint files and upstream
requires one logical change per PR. The old combined branch still exists at
`3a7a838063` and should be ignored or deleted, not submitted.

Order: send **#1 first** — smallest, least contentious, no gate. Then wait for a
reaction before sending more; `PR-BODIES.md`'s "don't submit the whole batch at
once" advice still holds with six. #6 stays closed until a maintainer answers
#10015.

Every one of the six still needs two things that cannot be done for you: one
sentence in your own words in the body, and a hands-on exercise of the
behaviour. Upstream states `bun check` passing is not sufficient verification,
and closes PRs whose body lacks the sentence.

---

## 4. Rebase — ALREADY DONE, and one correction

Both branches have been replayed onto **current upstream main** and force-pushed
to the fork. You do not need to rebase, install, or build anything to open the
PRs. State as of this update:

| Branch | New head | Base | Diff | Verification |
| --- | --- | --- | --- | --- |
| `fix/subagent-label-sanitize` | `b8fb671f27` | `upstream/main` @ `caefa61023` | 5 files, +162/−7 | `tsc` exit 0; 131 pass / 2 skip / 0 fail across 11 label+title+agent-hub test files |
| `feat/opt-in-auto-update` | `78f9165f02` | `upstream/main` @ `caefa61023` | 6 files, +269/−15 | `tsc` exit 0; own test file 6/6 pass |

Both commits keep `Hunter-124` as author, because he wrote the code. Each now
carries its own `## [Unreleased]` changelog entry — `### Fixed` for the label
fix, `### Added` for auto-update. That was the single most common review comment
on the three sibling PRs, so it is no longer outstanding.

The `Co-authored-by:` trailer for Michael was changed from
`iamnotyobabydaddy@gmail.com` to `iamnotyobabydaddy@users.noreply.github.com`,
which is the only form measurably proven to resolve to his account — that is
why the head SHAs moved from `72fae9c0b4`/`6aa21d7894`. The trees are
byte-identical (asserted via `^{tree}` equality before pushing). Charles's
trailer is untouched. Evidence in `HANDOFF-TO-HUNTER.md` §2.

**The correction:** the previous version of this section said to
`git rebase origin/main`. That would have been wrong and would have produced an
unreviewable PR. `origin` is the fork, and the fork's `main` is
`upstream/main` **plus 47 fork-only commits** — the Chudcode rebrand, the
CloudCastle packages, the desktop IDE runtime. Rebasing onto it puts all of that
in the diff. An upstream PR must be based on `can1357/oh-my-pi` main:

```bash
git remote add upstream https://github.com/can1357/oh-my-pi.git   # once
git fetch upstream main
git switch -c <branch> upstream/main && git cherry-pick <commit>
```

Diff purity was confirmed for both branches:
`git diff upstream/main..HEAD | grep -ci 'chudcode\|cloudcastle'` returns **0**,
and `git rev-list --count upstream/main..HEAD` returns **1**.

Two things worth knowing about the replay, because a reviewer may ask:

- In `fix/subagent-label-sanitize`, the original patch modified `sanitizeLine()`
  in `src/modes/components/agent-hub.ts`. Upstream has since moved that function
  to `src/modes/components/agent-hub-renderer.ts` and split it into
  `sanitizeDisplayText()` plus truncation, so the change now lands there and
  `agent-hub.ts` is untouched. Upstream also added `labelEchoesHandle()` to
  `src/task/label.ts` in the meantime; both guards are kept, and `sanitizeTaskLabel`
  runs **before** the echo check so markup cannot smuggle a handle-echoing label
  past it (`Loader</title>` against handle `Loader`).
- In `feat/opt-in-auto-update`, `src/cli/update-cli.ts` is a pure `+74/−0`
  addition against pristine upstream. 16 failures in the pre-existing
  `test/update-cli.test.ts` on a Windows host are environmental (real `fs.symlink`
  needing elevation, POSIX `0o755` mode assertions, exec'ing a fake non-ELF
  binary, a hardcoded `curl` installer hint) and touch none of the functions this
  patch adds. Verify on Linux before quoting numbers to a maintainer.

---

## 5. `fix/subagent-label-sanitize`

- **Branch:** `fix/subagent-label-sanitize`
- **Head SHA:** `b8fb671f27` — "fix(coding-agent): strip model-emitted title
  markup from subagent labels", replayed onto `upstream/main` @ `caefa61023`.
  (Earlier SHAs `b4e528a3ca` and `72fae9c0b4` are superseded and gone.)
- **Diffstat vs `upstream/main`:** 5 files changed, 162 insertions(+), 7 deletions(-)
  - `packages/coding-agent/CHANGELOG.md` (+4)
  - `packages/coding-agent/src/modes/components/agent-hub-renderer.ts` (+5/−1)
  - `packages/coding-agent/src/task/label.ts` (+20/−1)
  - `packages/coding-agent/src/utils/title-generator.ts` (+10/−5)
  - `packages/coding-agent/test/task-label-sanitization.test.ts` (new, +130)
  - note: `agent-hub.ts` is deliberately NOT in the diff — see §4.
- **Title:** `fix(coding-agent): strip model-emitted title markup from subagent labels`
- **Verified:** `tsc` exit 0; 131 pass / 2 skip / 0 fail across 11 test files,
  including upstream's own `task-label.test.ts` and `title-generator.test.ts`.

**Command — the branch is ready; this is the only step left besides your sentence:**

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
- **Head SHA:** `78f9165f02` — "feat(coding-agent): opt-in automatic update
  staging", replayed onto `upstream/main` @ `caefa61023`.
  (Earlier SHAs `94c56c4898` and `6aa21d7894` are superseded and gone.)
- **Diffstat vs `upstream/main`:** 6 files changed, 269 insertions(+), 15 deletions(-)
  - `packages/coding-agent/CHANGELOG.md` (+4)
  - `packages/coding-agent/src/cli/update-cli.ts` (+74/−0 — a pure addition)
  - `packages/coding-agent/src/config/settings-schema.ts` (+17)
  - `packages/coding-agent/src/main.ts` (+105/−16)
  - `packages/coding-agent/src/modes/utils/ui-helpers.ts` (+7/−4)
  - `packages/coding-agent/test/startup-auto-update.test.ts` (new, +73)
- **Verified:** `tsc` exit 0; own test file 6/6 pass. See §4 on the 16
  environmental `update-cli.test.ts` failures on Windows.
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

**Status of that gate:** Discord was unreachable for this account, so upstream's
public Ideas Discussions were used instead — this branch's thread is
[#10015](https://github.com/can1357/oh-my-pi/discussions/10015), opened by
Hunter-124 at 23:50 on 2026-08-27. It has **zero replies** as of this update, so
the gate is open, not cleared. Nobody posted anything as you.

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

1. CHANGELOG — **already addressed.** The `[Unreleased] / ### Added` entry is in
   the rebased commit.
2. What does the user actually see when SHA-256 verification fails on a
   raw-binary update — a visible error, or a silent fall-back to notify-only?
   "Fails closed" needs a concrete, observable answer.
3. Staleness — **already addressed.** The branch is now based on
   `upstream/main` @ `caefa61023`, with `tsc` green and its own test file
   passing; see §4. If asked, say it was replayed onto current upstream main and
   retested, not diffed against an old base.
4. How does the code reliably detect "this is a source checkout / `bun link`"
   to exclude it from `auto`, and what happens if that detection is wrong?

---

## 7. Confirmation

**Not done, and deliberately left to you:** no `gh pr create` was run, no PR or
issue was opened, edited, or commented on, and no `> YOUR SENTENCE HERE` line
was filled in anywhere. Upstream requires that sentence to be yours, and
`ONBOARDING.md` reserves the submission itself for you.

**Done on your behalf, since it is machine work rather than authorship:** both
branches were replayed onto `upstream/main` @ `caefa61023`, given their
`[Unreleased]` changelog entries, typechecked, tested, and force-pushed to the
fork's own feature branches — never to `main`, on either remote. Original
authorship (`Hunter-124`) and both `Co-authored-by:` trailers were preserved.

Every branch/commit/diffstat claim came from local `git` run against this
checkout on 2026-08-27, and every PR-state claim came from a live GitHub lookup
(`pr://can1357/oh-my-pi/9925`, `/9926`, `/9927`, plus `search_prs` for
`author:Hunter-124` and for the two remaining branch names) run the same day.

## 8. What is left — two steps

1. Write one sentence per PR in your own words, replacing
   `> YOUR SENTENCE HERE` in §5 (and §6 after its Discord thread).
2. Exercise the behavior by hand. Upstream states `bun check` passing is not
   sufficient. For `fix/subagent-label-sanitize`: build the branch, spawn
   subagents, and confirm no label renders a stray tag while `Map<K,V>` still
   shows correctly.

Then run the `gh pr create` in §5. `feat/opt-in-auto-update` additionally waits
on its Discord thread.
