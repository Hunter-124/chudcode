# Handoff to Hunter — 2026-08-27, evening (Michael's session)

Everything below happened on the fork only. **No PR was opened, no issue was
filed, no GitHub comment was posted, and nothing was pushed to `main` on
`upstream`.** The one `main` push is this docs commit on `origin`.

Six branches are now submission-ready against current `upstream/main`
(`caefa61023`, v18.0.8) — each exactly **1 commit ahead, 0 behind**.

---

## 1. Branch state after this session

| Branch | Before | After | What happened |
| --- | --- | --- | --- |
| `fix/subagent-label-sanitize` | `72fae9c0b4` | **`b8fb671f27`** | Co-author trailer email only; tree byte-identical |
| `feat/opt-in-auto-update` | `6aa21d7894` | **`78f9165f02`** | Same — trailer only, tree byte-identical |
| `feat/opt-in-escape-dismiss` | `4f7bd88a65` (Jul 23) | **`7d651adb06`** | Replayed onto `upstream/main` + changelog + trailer |
| `feat/cross-platform-antisleep` | `298ee908ca` (Jul 23) | **`36074ff860`** | Replayed onto `upstream/main` + changelog + trailer |
| `feat/catalog-cursor-effort` | — | **`a00fcca02d`** | **New.** Split half 1 of the combined catalog branch |
| `feat/catalog-release-date` | — | **`0292b2af59`** | **New.** Split half 2 |
| `feat/catalog-cursor-effort-and-release-date` | `3a7a838063` | `3a7a838063` | **Untouched.** Superseded by the two above; delete it when you agree with the split |

Every push used `git push --force-with-lease=<branch>:<old-sha>`. None of the
leases failed, so nothing you pushed during that window was clobbered. If you
had a local copy of the four rewritten branches, `git fetch && git reset --hard
origin/<branch>` — the trees are unchanged, only the commit objects moved.

---

## 2. Why the two already-ready branches were rewritten

Only to make Michael's contribution actually count. The trailer said
`Co-authored-by: iamnotyobabydaddy <iamnotyobabydaddy@gmail.com>`, and GitHub
only attaches co-author credit when the trailer email maps to an account.

Measured, not assumed:

```
gh api search/commits q="author-email:iamnotyobabydaddy@gmail.com"
  → total_count 0 (globally, not just this fork)
gh api search/commits q="author-email:iamnotyobabydaddy@users.noreply.github.com"
  → 5 commits, every one resolving to author.login = iamnotyobabydaddy
```

So the trailer on all six branches now reads
`Co-authored-by: Michael Edmonds <iamnotyobabydaddy@users.noreply.github.com>`,
which is the form proven to resolve. `Co-authored-by: Charles Edmonds` is
untouched.

**You remain the commit author on all six** — you wrote the code and the
`ONBOARDING.md` attribution decision says credit follows who did the work. The
commits were rewritten with `git commit-tree` against the original tree object,
and tree equality was asserted (`<new>^{tree} == <old>^{tree}`) before each
push, so not one byte of your code changed.

---

## 3. Replay notes a reviewer will ask about

### `feat/opt-in-escape-dismiss` → `7d651adb06`
8 files, +214/−6. `bun test` across 9 related files: **100 pass / 0 fail**.
`tsc -p packages/coding-agent`: exit 0.

- Real conflict: `src/modes/components/agent-dashboard.ts` was a modify/delete.
  Upstream `a53e4e790d` (2026-08-13) replaced `AgentDashboard` with
  `AgentsHubComponent` in `agents-hub.ts` on a different input-handling shape
  (`matchesSelectCancel` + `#callbacks.onCancel` instead of
  `matchesAppInterrupt` + `this.onClose?.()`). The file was deleted and the
  one-line intent reimplemented in `agents-hub.ts`: the search-query guard now
  reads `&& !this.#settings.get("tui.escapeClosesOverlay")`, placed after the
  existing `#assigning` check so in-flight model assignment still cancels first.
- The upstream test the opt-in exists for **is still there**:
  `packages/coding-agent/test/model-hub.test.ts:1088`, `"Escape clears an active
  query before closing the hub"` — two `\x1b` presses, `onCancel` not called
  after the first. So the setting is still the right shape; a plain behaviour
  change would break that test.

### `feat/cross-platform-antisleep` → `36074ff860`
11 files, +1147/−56. `bun test .../sleep-inhibitor.test.ts`: **10 pass / 0 fail**.
`tsgo --noEmit`: 0 errors.

- Conflicts were both in `session/agent-session.ts`: the pi-utils import list
  (`$env` vs `APP_NAME` — kept both, `APP_NAME` is now the inhibitor's `who:`
  identity) and a stale `advisorSystemPrompt` re-import that was dropped after
  grepping and confirming it is unused on current main (that logic moved to
  `session-advisors.ts` during the drift).
- The changelog entry auto-merged into the **archived** section near the bottom
  of the file, because the pre-rebase patch context still matches there
  verbatim. Moved to `## [Unreleased]` → `### Added`. Worth watching for on any
  other replay of a July branch.
- One deliberate deviation from your original patch: `Bun.which("systemd-inhibit")`
  → `$which(...)` from `@oh-my-pi/pi-utils`, per `AGENTS.md`'s binary-lookup rule
  (same `string | null` signature, same behaviour, matches ~20 other callsites).
  `Bun.spawn` for the long-lived holder process was left alone — that is the
  sanctioned lifecycle-control case.
- Windows evidence: the committed `Win32PowerInhibitorBackend` was run directly
  on this host — `acquire("system")` → handle, held 2s, released, double-release
  safe — plus a raw `kernel32!SetThreadExecutionState` round-trip via `bun:ffi`
  showing `0x80000000 → 0x80000003 → 0x80000000`, i.e. the OS returned exactly
  the state we asked it to hold. `powercfg /requests` could **not** be used:
  it needs elevation, and this account has Administrators deny-only.

### `feat/catalog-cursor-effort` → `a00fcca02d` / `feat/catalog-release-date` → `0292b2af59`
Split because the two concerns touch disjoint files with no shared logic —
cursor-effort: `scripts/generated-policies.ts`, `src/build.ts`,
`src/discovery/cursor.ts`, `src/model-thinking.ts`; release-date:
`src/model-recency.ts` (new), `src/index.ts`, `src/types.ts`,
`src/provider-models/openai-compat.ts`. Only `CHANGELOG.md` overlapped.
Upstream requires one logical change per PR, so this avoids a guaranteed
split request. Tests: 142 pass / 0 fail and 89 pass / 0 fail respectively;
`check:types` exit 0; biome clean.

Two things to disclose in those PR bodies, or a reviewer will find them:

- **`models.json` is deliberately unregenerated.** `AGENTS.md` forbids
  hand-editing it, and `bun run gen:models` needs live Cursor discovery
  (`CURSOR_API_KEY`/OAuth) plus credentials for xai-oauth, Antigravity, Codex,
  `GMI_API_KEY`, `YOLO_AUTO_API_KEY`, `AIAND_API_KEY`. Running it credential-less
  would silently swap many unrelated providers to fallback rows. So the fix is
  live for anything going through `buildModel()` and Cursor's live discovery, but
  the bundled snapshot still shows `reasoning:false` for e.g.
  `gpt-5.2-codex-low`. **Someone with those credentials needs a follow-up regen
  commit.**
- The original branch's Cursor tests imported `RAW_MODELS` from `models.json`,
  which `AGENTS.md` explicitly bans and which fails today anyway (two of its four
  test ids no longer exist in the bundle). They were rewritten to exercise
  `getCursorModelIdThinking()`, `buildModel()`, and
  `applyGeneratedModelPolicies()`/`rebakeModelThinking()` instead.
- `src/build.ts` needed real integration work, not just conflict resolution:
  upstream added `requiresGlyphTokenization`, tokenizer resolution, and
  `supportsComputerUse(Config)` to the returned `Model`. All three were rewired
  to read from the cursor-corrected `normalizedSpec` rather than the raw spec, so
  the two changes compose instead of one discarding the other.

---

## 4. Not done — deliberately left to you and Michael

- **No PR opened for any of the six.** `fix/subagent-label-sanitize` is the only
  one clear to send immediately.
- **Michael's own-words sentence is still missing** on every body. Upstream
  closes PRs without it, and it has to be his line, not a generated one.
  `PR-BODIES.md` and `MIKEY-SUBMIT.md` §5/§6 hold the rest of each body verbatim.
- **The hands-on exercise is still outstanding** on all six. `bun check` passing
  is explicitly not sufficient upstream.
- **`feat/opt-in-auto-update` stays gated.** Your Ideas discussion
  [#10015](https://github.com/can1357/oh-my-pi/discussions/10015) (opened
  23:50 today) has zero replies. Discord itself was unreachable for this
  account, and no attempt was made to post as you.
- **`models.json` regen** for the Cursor fix, per §3.
- Nothing was done about the `footer.ts:95` unguarded `git.head.resolveSync()`
  landmine recorded in `HANDOFF.md` §5 — still dead code, still unfiled.

---

## 5. Gotcha worth keeping

A fresh `git worktree` + `bun install` cannot run `bun test` on this host:
`packages/natives/native/` ships no prebuilt `.node`, so every test dies with
`Failed to load pi_natives native addon for win32-x64`. Copying
`pi_natives.win32-x64-baseline.node` from the main checkout's already-built
`packages/natives/native/` into the worktree unblocks it (untracked build
artifact, never staged). The alternative is a real
`bun --cwd=packages/natives run build`, which needs a Rust toolchain this host
does not have.
