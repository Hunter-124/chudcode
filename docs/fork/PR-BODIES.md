# PR bodies — ready to submit from Hunter-124/oh-my-pi

Five branches are pushed and verified on the fork. Each is one logical change
with tests.

**Before submitting each one, iamnotyobabydaddy must:**

1. Read the diff (`gh pr diff` or the Files tab). These are small; all five
   together are ~250 lines.
2. Replace the `> YOUR SENTENCE HERE` line with one sentence in his own words.
   Upstream requires this explicitly and closes PRs that lack it. A generated
   summary does not satisfy it. One honest line is enough.
3. Actually exercise the behavior. Upstream states `bun check` passing is not
   sufficient verification. The exercise step for each is written below.

Do **not** submit all five at once. Send `feat/editor-redo` and
`fix/oauth-close-window` first — they are the smallest and least contentious.
Wait for a reaction before sending the rest, so a single disagreement does not
sink the batch.

Upstream also requires **Discord discussion before implementation** for major
features. `feat/opt-in-auto-update` plausibly counts (it changes startup
behavior and can install software). Raise it in Discord before opening that PR;
the other four are narrow bug fixes and can go straight to PRs.

Open with:

```bash
gh pr create --repo can1357/oh-my-pi \
  --head Hunter-124:<branch> --base main \
  --title "<title below>" --body-file <body below>
```

---

## 1. `feat/editor-redo`

**Title:** `feat(tui): add editor redo`

**Exercise:** run `chudware-code`, type a few words, press `ctrl+-` to undo, then `alt+-`
to redo. Confirm the text comes back and the cursor lands where it was. Then
type something new after an undo and confirm `alt+-` does not resurrect the
discarded branch. Also confirm `ctrl+z` still suspends omp.

**Body:**

> YOUR SENTENCE HERE
>
> Undo already existed on `ctrl+-` / `ctrl+_` but there was no redo, so an
> accidental undo was unrecoverable.
>
> Adds a redo stack to both text widgets (`Editor` and `Input`, which maintain
> independent undo stacks) behind a new `tui.editor.redo` binding defaulting to
> `alt+-` / `alt+_`, mirroring undo's readline-style pair.
>
> Deliberately **not** bound to `ctrl+shift+z`: legacy terminals collapse that to
> plain `ctrl+z`, which is already claimed by `app.suspend`, so the familiar
> binding would break process suspend. It is remappable via `keybindings.yml`
> for terminals that can encode it.
>
> A fresh edit clears the redo stack, and both stacks are cleared wherever the
> undo stack already was (`#setTextInternal`, `#submitValue`) so a restored draft
> cannot resurrect a previous one.
>
> Tests: 7 added in `packages/tui/test/editor.test.ts` covering replay, full
> history walk, cursor restoration, no-op on empty stack, branch invalidation,
> stack clearing on submit, and the remapped binding. Full `packages/tui` suite:
> 1354 pass, 0 fail.

---

## 2. `fix/oauth-close-window`

**Title:** `fix(ai): degrade the OAuth close button when the tab is not script-closable`

**Exercise:** run `chudware-code login` for any OAuth provider, complete the flow in a
Chromium-based browser, and confirm the success page no longer shows a dead
"Close Window" button — after a moment it tells you to close the tab yourself.

**Body:**

> YOUR SENTENCE HERE
>
> The auth success page offered a "Close Window" button and promised an automatic
> close, but neither could work. Per the HTML spec a script may only close a
> browsing context it opened, or a top-level traversable whose session history has
> exactly one entry. The OAuth redirect chain (provider consent →
> `127.0.0.1:<port>/oauth-callback`) leaves more than one entry, so
> `window.close()` is a silent no-op and Chromium logs "Scripts may close only the
> windows that were opened by them".
>
> Reproduced on Brave and Chrome on Linux; the button did nothing and the page sat
> there claiming it would close.
>
> Still attempts the close, since it legitimately succeeds when a provider used a
> script-opened popup, then detects that the document survived and replaces the
> dead control with an instruction to close the tab manually. Error path
> unchanged.
>
> Tests: `packages/ai/test/callback-server-launch-route.test.ts` updated for the
> new copy plus an assertion that the fallback is present in the served page.
> 8 pass, 0 fail.

---

## 3. `fix/status-bar-duplicate-count`

**Title:** `fix(coding-agent): stop the status bar counting subagents twice`

**Exercise:** run a session that spawns subagents and confirm the bar no longer
shows `⚘ N agents` beside a `⚙ N` with the same N. Then start a background bash
job and confirm `⚙ 1` appears independently.

**Body:**

> YOUR SENTENCE HERE
>
> The status bar rendered `⚘ N agents` immediately followed by `⚙ N`, and both
> tracked the same population: every task-tool spawn registers an `AgentRegistry`
> ref (`kind: "sub"`) *and* an `AsyncJobManager` job of `type: "task"` with the
> same agent id (`task/index.ts:1098-1101`), so the two badges moved together and
> neither number meant anything on its own.
>
> Counts only `bash` jobs in the job badge, leaving the two badges disjoint:
> subagents on one, genuine background jobs on the other.
> `AsyncJobManager.getRunningJobs()` semantics are unchanged for other consumers —
> the filter is applied at the badge's data source. The existing zero-suppression
> is preserved, so no bare `⚙ 0` appears.
>
> Tests: 1 added covering N task subagents producing no job badge, and one bash
> job rendering `⚙ 1`.

---

## 4. `fix/subagent-label-sanitize`

**Title:** `fix(coding-agent): strip model-emitted title markup from subagent labels`

**Exercise:** spawn subagents and confirm no label shows a stray tag. The
original sighting was a real subagent label rendering as
`Map TUI editor for undo/redo feature</title>`.

**Body:**

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

---

## 5. `feat/opt-in-auto-update` — **Discord first**

**Title:** `feat(coding-agent): opt-in automatic update staging`

**Exercise:** set `startup.autoUpdate` to each of `off` / `notify` / `auto` and
launch Chudware Code; confirm `notify` behaves exactly as before, `off` skips the check,
and `auto` stages an update and reports that it applies next launch. Confirm a
second launch inside the throttle window does not re-hit the registry.

**Caveat to disclose in the Discord thread:** this touches update/installation
behavior, which is security-sensitive. The branch adds SHA-256 verification
against GitHub's published asset digests for raw-binary updates and fails
closed, because auto-applying an unverified binary would be worse than requiring
a manual `chudware-code update`. Package-manager flavors delegate integrity to the package
manager. Source / `bun link` checkouts are excluded entirely.

**Body:**

> YOUR SENTENCE HERE
>
> Chudware Code notified about new versions but never applied them, while a complete
> self-updater already existed behind `chudware-code update` and was simply never wired to
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

---

# Issues filed (no PR — reported for upstream to own)

These were filed rather than patched, deliberately.

- **#9915** — Corrupt session header silently discards the transcript and
  overwrites it on resume. Severe silent data loss. Not patched because the fix
  is a failure-semantics decision plus a recovery surface.
- **#9916** — Concurrent sessions exhaust the host; subagent cap is count-only
  and nothing checks memory. Includes measurements from this machine.
- **#9917** — Deleting a pasted image's `[Image #N]` marker does not un-attach
  it; it is still submitted. Not patched because the obvious fix breaks ~20
  existing tests that encode the opposite contract — that question is upstream's
  to answer.
