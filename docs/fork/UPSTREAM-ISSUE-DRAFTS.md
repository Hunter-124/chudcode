# Upstream issue drafts

These drafts preserve the historical source used for findings that were untracked and suitable for GitHub when drafted. All three have since been filed upstream. Source links were rechecked against upstream `main` at [`7261e214e45a2779e488dd390d447a80c0bcb03d`](https://github.com/can1357/oh-my-pi/commit/7261e214e45a2779e488dd390d447a80c0bcb03d).

## SESSION-003

**Status:** Filed as [#10006](https://github.com/can1357/oh-my-pi/issues/10006).

### Title

feat(cli): add a read-only session doctor with safe repair output

### Observed behavior

OMP has several automatic, internal recovery rules, but no user-invocable way to inspect a session file and learn which rules apply. A user whose session will not resume cleanly can navigate branches with `/tree` or manually inspect JSONL, but cannot ask OMP to identify a torn record, a stranded backup, a broken parent reference, or an unmatched tool call/result pair. Some replay hazards are normalized in memory, so a resumed transcript can differ from the stored file without a concise diagnostic report explaining why.

### Current source evidence

- Session listing automatically promotes the newest orphaned `*.jsonl.<snowflake>.bak` only when the primary file is missing, while a separate read-only listing path deliberately avoids mutation: [`session-listing.ts:521-618`](https://github.com/can1357/oh-my-pi/blob/7261e214e45a2779e488dd390d447a80c0bcb03d/packages/coding-agent/src/session/session-listing.ts#L521-L618).
- Context reconstruction strips unmatched `toolCall` blocks, clears protected thinking signatures on rewritten turns, and removes paired results when failed assistant turns are dropped: [`session-context.ts:500-585`](https://github.com/can1357/oh-my-pi/blob/7261e214e45a2779e488dd390d447a80c0bcb03d/packages/coding-agent/src/session/session-context.ts#L500-L585). These are useful recovery primitives, but they are not exposed as diagnostics.
- The current user-facing `/tree` command is explicitly a branch navigator: [`builtin-session.ts:501-508`](https://github.com/can1357/oh-my-pi/blob/7261e214e45a2779e488dd390d447a80c0bcb03d/packages/coding-agent/src/slash-commands/builtin-session.ts#L501-L508).

### Expected behavior

Given a session id or JSONL path, OMP should be able to explain whether the persisted session is structurally healthy, what the normal loader would ignore or rewrite, and which deterministic recovery actions are available. Inspection must be read-only by default. A repair request must never silently destroy or overwrite the only copy of a transcript.

### Bounded proposal

Add a CLI surface such as:

```text
omp session doctor <session-id-or-path> [--json]
omp session doctor <session-id-or-path> --repair-output <new-path>
```

Keep the first increment limited to persisted session structure:

1. Parse with the production session entry/schema code and report the first malformed or torn JSONL record with its line/byte offset.
2. Report invalid or missing headers, missing parent targets/cycles, unmatched `toolCall`/`toolResult` ids on resolved branches, and eligible orphaned backup files.
3. Preview the same deterministic replay normalization already performed by `session-context.ts`, with counts and entry ids; do not invent model-generated repairs.
4. Make normal doctor mode strictly read-only.
5. When `--repair-output` is supplied, write a complete repaired copy atomically to a different path. Never replace, truncate, or delete the source file in this initial scope.
6. Return a stable nonzero exit code for structural errors and provide `--json` output suitable for support bundles. Do not include message bodies or tool arguments in the default human or JSON report; expose ids, roles, counts, offsets, and reason codes only.

Out of scope: resuming killed tools, reconstructing missing model output, persisting async-job state, or redesigning the session picker.

### Acceptance / verification

- A healthy disposable session reports `healthy` and exits zero without changing any file metadata or content.
- Fixtures covering a torn final line, missing parent, cycle, dangling tool call, orphan tool result, and stranded backup each produce a specific reason code and nonzero exit.
- Default text and `--json` output contain no transcript text, tool arguments, tokens, credentials, or absolute paths unless the user explicitly requested a path-bearing field.
- Running doctor twice is read-only and byte-for-byte idempotent.
- `--repair-output` leaves the source byte-for-byte unchanged, creates a parseable new session atomically, and reports every omitted or rewritten entry by id and reason.
- Loading the repaired copy through the normal session loader yields the same replayable context as the doctor's preview.
- Existing `/tree`, resume, and automatic orphan-backup recovery behavior remains unchanged.

### Privacy-safe reproduction

1. Create a disposable empty repository and a disposable OMP session containing only the prompt `Reply with OK`, then exit normally.
2. Copy its JSONL to a temporary path; never edit the original.
3. In separate copies, truncate the final JSONL line or append a synthetic assistant `toolCall` entry without a matching `toolResult`.
4. Try to inspect the copies using supported session commands. `/tree` can navigate a loadable tree, but there is no command that reports the structural fault or previews the loader's normalization.
5. Share only the synthetic copies or structural counts in the issue; do not attach a real session transcript.

### Duplication search notes

- [#9915](https://github.com/can1357/oh-my-pi/issues/9915) was a specific, now-closed header data-loss bug; it did not add a general diagnostic command.
- [#8596](https://github.com/can1357/oh-my-pi/issues/8596) fixed the specific ENOSPC/torn-write path; it did not expose diagnosis of existing files.
- [#9854](https://github.com/can1357/oh-my-pi/issues/9854) fixed one Cursor replay-poisoning case; it did not add a provider-independent doctor.
- [#3597](https://github.com/can1357/oh-my-pi/issues/3597) tracks discovery and recovery visibility after a host/process dies, including durable job/subagent state. This draft is narrower: inspect one persisted session's structure and emit a safe repaired copy. It does not duplicate the heartbeat, resume-picker, or async-ledger work in #3597.
- Repository issue searches for `session repair doctor corrupted transcript`, `session diagnostic recover resume JSONL`, and `orphaned tool result session transcript repair` found no issue owning this bounded CLI surface.

## TUI-007

**Status:** Filed as [#10007](https://github.com/can1357/oh-my-pi/issues/10007).

### Title

feat(tui): add a lifecycle-owned animated quota gauge to the usage status-line segment

### Observed behavior

The `usage` status-line segment renders provider quota windows as static text such as `5h 23%` and `7d 61%`. It repaints when an asynchronous usage refresh changes the cached report, but it has no visual gauge and no transition between the old and new values. The existing segment renderer is pure and has no animation lifecycle, so putting a timer directly in `render()` would leak work and trigger render-path side effects.

### Current source evidence

- The current segment formats only tier, percentage, and reset text: [`segments.ts:684-750`](https://github.com/can1357/oh-my-pi/blob/7261e214e45a2779e488dd390d447a80c0bcb03d/packages/coding-agent/src/modes/components/status-line/segments.ts#L684-L750).
- Usage reports are refreshed off the render path, cached for five minutes, and request a repaint only when the normalized snapshot changes: [`component.ts:1290-1363`](https://github.com/can1357/oh-my-pi/blob/7261e214e45a2779e488dd390d447a80c0bcb03d/packages/coding-agent/src/modes/components/status-line/component.ts#L1290-L1363).
- Interactive mode owns the status component, wires its change callback to the TUI, and disposes it with the session UI: [`interactive-mode.ts:1181-1185`](https://github.com/can1357/oh-my-pi/blob/7261e214e45a2779e488dd390d447a80c0bcb03d/packages/coding-agent/src/modes/interactive-mode.ts#L1181-L1185), [`interactive-mode.ts:2120-2131`](https://github.com/can1357/oh-my-pi/blob/7261e214e45a2779e488dd390d447a80c0bcb03d/packages/coding-agent/src/modes/interactive-mode.ts#L2120-L2131), and [`interactive-mode.ts:4690-4692`](https://github.com/can1357/oh-my-pi/blob/7261e214e45a2779e488dd390d447a80c0bcb03d/packages/coding-agent/src/modes/interactive-mode.ts#L4690-L4692).
- `Loader` is the established lifecycle pattern for bounded animation: scheduled ticks, component repaint requests, render-cost backpressure, and idempotent disposal: [`loader.ts:98-176`](https://github.com/can1357/oh-my-pi/blob/7261e214e45a2779e488dd390d447a80c0bcb03d/packages/tui/src/components/loader.ts#L98-L176).
- Users can already disable decorative animation with `display.shimmer: disabled`: [`settings-schema.ts:1293-1306`](https://github.com/can1357/oh-my-pi/blob/7261e214e45a2779e488dd390d447a80c0bcb03d/packages/coding-agent/src/config/settings-schema.ts#L1293-L1306).

### Expected behavior

When supported quota data arrives, the status line should communicate the consumed fraction with a compact gauge as well as a numeric percentage. A changed quota snapshot should transition smoothly to its new value, then become static. The feature must not create a perpetual idle repaint loop, duplicate provider requests, or make the numeric value inaccessible in narrow terminals or with animation disabled.

### Bounded proposal

1. Extend the existing `usage` segment with a width-aware text gauge, for example `5h ▰▰▱▱ 43%`, while retaining the exact numeric percentage and reset text.
2. Animate only a bounded transition from the previously displayed percentage to a newly fetched percentage (for example 250–400 ms). Do not animate continuously while the value is unchanged.
3. Keep interpolation state and timer ownership outside the pure segment renderer, on the status component/interactive lifecycle. Request repaints through the TUI/component scheduling path and cancel all pending work on disposal or session/model/account change.
4. Reuse the loader's render-cost backpressure principles rather than introducing an independent high-frequency loop.
5. When `display.shimmer` is `disabled`, render the final gauge immediately with no transition. At widths where the gauge would crowd other segments, fall back to today's percentage/reset text.
6. Do not change usage-fetch cadence, provider APIs, preset membership, or quota normalization in this issue.

### Acceptance / verification

- With a synthetic snapshot change from 20% to 60%, a deterministic scheduler observes at least one intermediate gauge frame and a final `60%` frame within the bounded transition duration.
- Once the final frame is reached, no animation timer or scheduled repaint remains.
- Disposing or switching the status component mid-transition cancels its timer and prevents late repaint callbacks.
- `display.shimmer: disabled` produces the final static gauge on the first render and schedules no animation.
- Narrow-width rendering falls back without truncating or hiding the numeric percentage.
- Unsupported providers and missing reports preserve the current invisible-segment behavior.
- The test drives `StatusLineComponent` with a synthetic normalized `UsageReport` and rendered output; it must fail if the transition is removed or if an idle timer remains.
- Existing five-minute usage fetch caching and account/model invalidation remain unchanged.

### Privacy-safe reproduction

Use the existing status-line test harness with an invented provider report (`fiveHour.percent = 23`, `sevenDay.percent = 61`) and no account identity. Render once, advance a virtual clock, and render again. Current `main` produces the same static percentage text at every time point because elapsed time is not part of the segment state. Do not post screenshots or payloads from a real paid account.

### Duplication search notes

- [#9929](https://github.com/can1357/oh-my-pi/issues/9929) and [PR #9983](https://github.com/can1357/oh-my-pi/pull/9983) cover only discoverability by adding the existing static segment to shipped presets.
- The maintainer explicitly recorded that animation is a separate feature because the current segment displays cached snapshots rather than a gauge: [#9929 comment](https://github.com/can1357/oh-my-pi/issues/9929#issuecomment-5437026621).
- Repository issue search for `animated usage gauge status line quota` returned #9929 only; no issue owns the animation lifecycle or gauge behavior proposed here.

## NOTIFY-001

**Status:** Filed as [#10008](https://github.com/can1357/oh-my-pi/issues/10008).

### Title

feat(tui): add a macOS desktop-notification fallback for BEL-only terminals

### Observed behavior

OMP can send in-band OSC notifications through terminals that support them. For BEL-only terminals, it adds an out-of-process desktop fallback only on Linux. On macOS, the fallback gate always returns false, so a BEL-only terminal can ring or flash but cannot carry OMP's title/body as a Notification Center toast. Terminals with working OSC notification support are not affected by this gap.

### Current source evidence

- The fallback is explicitly Linux/D-Bus-specific and uses `notify-send` or `gdbus`: [`desktop-notify.ts:1-21`](https://github.com/can1357/oh-my-pi/blob/7261e214e45a2779e488dd390d447a80c0bcb03d/packages/tui/src/desktop-notify.ts#L1-L21) and [`desktop-notify.ts:85-103`](https://github.com/can1357/oh-my-pi/blob/7261e214e45a2779e488dd390d447a80c0bcb03d/packages/tui/src/desktop-notify.ts#L85-L103).
- `hasLinuxDesktopSession()` rejects every non-Linux platform, and `shouldDeliverDesktopNotification()` depends on it: [`desktop-notify.ts:39-74`](https://github.com/can1357/oh-my-pi/blob/7261e214e45a2779e488dd390d447a80c0bcb03d/packages/tui/src/desktop-notify.ts#L39-L74).
- `TerminalInfo.sendNotification()` invokes the desktop fallback only after emitting the normal in-band/BEL form and only for a BEL protocol: [`terminal-capabilities.ts:182-190`](https://github.com/can1357/oh-my-pi/blob/7261e214e45a2779e488dd390d447a80c0bcb03d/packages/tui/src/terminal-capabilities.ts#L182-L190).
- The current spawn is already fire-and-forget and deliberately cannot delay process exit: [`desktop-notify.ts:165-183`](https://github.com/can1357/oh-my-pi/blob/7261e214e45a2779e488dd390d447a80c0bcb03d/packages/tui/src/desktop-notify.ts#L165-L183).

### Expected behavior

On a macOS desktop session using a BEL-only terminal, existing completion/error/input-required notifications should also appear as one-way Notification Center toasts with the same title and body. OSC-capable terminals must continue using their native path without duplicate toasts. Notification failure must remain best-effort and must never block OMP shutdown.

### Bounded proposal

1. Add a macOS adapter to the existing desktop-fallback path using the system `/usr/bin/osascript` `display notification` command.
2. Gate it on `process.platform === "darwin"`, BEL-only notification protocol, the existing `PI_NO_DESKTOP_NOTIFY=1` opt-out, and availability of the system helper.
3. Pass title/body as positional `osascript` arguments to a static script; never interpolate notification text into AppleScript source or a shell command.
4. Preserve the current fire-and-forget, ignored-stdio, non-throwing behavior. A missing helper or unavailable GUI session remains a silent no-op after the BEL is emitted.
5. Keep this first increment one-way. Do not add click-to-focus, actions, permission callbacks, persistence controls, installer identity, or conversation previews.
6. Do not change Windows behavior in this issue; native Windows notifications already have their own design thread.

### Acceptance / verification

- On `darwin` with a BEL protocol and available `osascript`, one detached notification process is spawned after the BEL path.
- Title/body containing quotes, backslashes, Unicode, newlines, and AppleScript-looking text remain argv data and cannot change the static script.
- OSC 9/99-capable terminals do not receive a duplicate desktop fallback.
- `PI_NO_DESKTOP_NOTIFY=1` suppresses the macOS fallback.
- Missing `osascript`, a failed spawn, or an unavailable GUI session does not throw, write to terminal output, or keep the process alive.
- Existing Linux `notify-send`/`gdbus` behavior and tests remain unchanged.
- Windows remains unchanged and covered by #7272.

### Privacy-safe reproduction

1. On macOS, use Terminal.app or another terminal that resolves to the BEL notification protocol.
2. Enable an existing notification trigger such as completion notification.
3. In a disposable directory, submit only `Reply with OK` and move the terminal to the background.
4. Current `main` emits the BEL behavior but no OMP title/body Notification Center toast through the desktop-fallback path.
5. Report the terminal name and macOS version only. Do not attach Notification Center screenshots, account identifiers, working-directory paths, or real prompt text.

### Duplication search notes

- [#3685](https://github.com/can1357/oh-my-pi/issues/3685) was the Linux/VTE gap that introduced the current D-Bus fallback; it is closed and does not cover macOS.
- [#7272](https://github.com/can1357/oh-my-pi/issues/7272) already tracks Windows notifications. The audit's original cross-platform observation was narrowed to macOS here to avoid duplicating that issue.
- [#7935](https://github.com/can1357/oh-my-pi/issues/7935) asks to expose notifications to extensions; it does not add a macOS delivery backend.
- [#9923](https://github.com/can1357/oh-my-pi/issues/9923) mentions the macOS/Windows asymmetry only as an adjacent observation in a settings issue; its tracked request is unrelated settings behavior.
- Repository issue searches for `notification macOS Windows toast fallback`, `desktop notification macOS OR Windows`, and `macOS notification osascript` found no standalone macOS fallback issue.
