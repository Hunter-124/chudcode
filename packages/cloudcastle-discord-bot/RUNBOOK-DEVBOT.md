# Runbook — run live chudcode sessions from Discord

Operator procedure for the **live session bot**: post in `#sessions`
(`1542631105608556574`, under the `chudcode` category) and get a real chudcode
agent session running against a checkout on the Windows workstation, with
progress and results posted back into a thread.

This is **not** the install described in `RUNBOOK-CREATE-APP.md`. That runbook
provisions a deliberately crippled, read-only app for the archive slice — it
cannot send a single message. This runbook **widens the same app's permissions**
so it can talk back. Do the archive install first if you have not; the token,
the application, and the guild are shared.

Every number below was re-derived, not copied. The agent half is verified on
this workstation (§4, "Prove the agent half first"); the **gateway half is
not** — no token has been on this box, so app identity, intents, permissions,
and thread creation are written from the implementation and Discord's
documented behaviour, not from an observed run.

## 0. Three things are left. Do them in this order.

1. **Re-invite the app** with `permissions=326417632320` (§1). The archive-slice
   mask has no send bit, so an app installed with it is mute. One URL visit.
2. **Paste the bot token** into
   `%USERPROFILE%\.config\cloudcastle\devbot\discord-token` (§3.1). The file is
   already created, locked, and proven against the loader's guard — it is empty
   and waiting.
3. **Set `CC_DEVBOT_OPERATORS`** to your and Hunter's user ids and start the bot
   (§3.2, §4). `CC_DEVBOT_WORKSPACES` too, if it is not persisted yet.

Then post anything in `#sessions`. If the bot reacts 👀 and opens a thread, all
three landed. If it is silent, go to §6 — the table is ordered by how often each
cause is the real one.

## 1. What changed, and why the app must be re-invited

The archive-slice mask is **`17179935744`** = View Channels + Read Message
History + Manage Threads. There is **no send bit in it at all**. An app
installed with that integer can read the guild and do nothing else — it will
connect, see your message, and be structurally incapable of replying. Widening
it is not optional.

A session bot must send, open threads, speak inside them, attach files, and
react. New permission integer: **`326417632320`**

| Bit | Value | Permission |
|---|---|---|
| `1 << 6` | 64 | Add Reactions |
| `1 << 10` | 1024 | View Channels |
| `1 << 11` | 2048 | Send Messages |
| `1 << 14` | 16384 | Embed Links |
| `1 << 15` | 32768 | Attach Files |
| `1 << 16` | 65536 | Read Message History |
| `1 << 34` | 17179869184 | Manage Threads |
| `1 << 35` | 34359738368 | Create Public Threads |
| `1 << 38` | 274877906944 | Send Messages in Threads |

Sum, low to high:
`64 + 1024 + 2048 + 16384 + 32768 + 65536` = `117824`;
`117824 + 17179869184 + 34359738368 + 274877906944` = **`326417632320`**.

Re-derive it yourself before pasting the URL. A mistyped digit here is the
difference between "can post in a thread" and "silently holds Administrator".

Why each of the nine is load-bearing:

- **View Channels / Read Message History** — see `#sessions` and thread
  backlog after a bot restart.
- **Send Messages** — post the thread's first status message.
- **Create Public Threads** — one thread per session. Public, not private:
  private threads need a separate bit and there is nothing in `#sessions` that
  the two founders should be hiding from each other.
- **Send Messages in Threads** — a separate bit from Send Messages. Omitting it
  is the classic failure: the bot opens the thread and then goes mute inside it.
- **Manage Threads** — rename a thread once the prompt's subject is clear, and
  unarchive a thread Discord auto-archived while a turn was still running.
- **Embed Links / Attach Files** — long answers go out as a `.md` attachment
  rather than eight chopped messages.
- **Add Reactions** — the acknowledgement tick, so a phone can tell "received"
  from "ignored".

**Confirmed absent from `326417632320`:** Administrator, Manage Channels,
Manage Guild, Manage Roles, Manage Messages, Mention Everyone, Kick Members,
Ban Members.

That absence is the safety story and it is worth stating in plain terms. The
bot **cannot delete a channel**, **cannot delete anyone else's message**, and
**cannot touch roles or membership**. It cannot pin, it cannot `@everyone`, and
it cannot grant itself anything — a Discord bot can only ever hold what the
install mask gave it. The `HANDOFF.md:166` rule that the bot never receives
channel or role deletion power survives this widening intact. The worst a
runaway session can do *inside Discord* is be noisy in its own thread. The
worst it can do *outside* Discord is section 3's problem, and that one is real.

### Re-inviting an app that is already installed

You do not remove the app and add it again, and you do not create a second
application. Visit the OAuth authorize URL again while signed in as a guild
admin: Discord recognises the existing integration and **updates its role's
permissions in place**. Same bot user, same application ID, same token — the
token is unaffected by re-invites, so nothing on disk needs to change.

Replace `<APPLICATION_ID>` and nothing else:

```
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=326417632320&guild_id=1542474553320542278&disable_guild_select=true
```

`disable_guild_select=true` pins the install to CloudCastle so a mis-click
cannot re-target another server.

**Before pressing Authorize, the consent screen must show:**

- server **CloudCastle** (`1542474553320542278`) — and no guild picker;
- exactly these nine and nothing else: Add Reactions, View Channels,
  Send Messages, Embed Links, Attach Files, Read Message History,
  Manage Threads, Create Public Threads, Send Messages in Threads.

If it lists **anything** beyond those nine — most importantly Administrator,
Manage Messages, Manage Roles, or Mention Everyone — **stop**, close the tab,
and re-check the URL. Do not "just authorize and fix it after"; the widened
role stays on the guild until an admin edits it by hand.

After authorizing, sanity-check in the client: Server Settings → Roles →
`CloudCastle Dev Bot`. The nine toggles should be on, everything else off. If
`#sessions` has a channel-level override denying Send Messages, the role is
irrelevant — the override wins. Clear it there.

## 2. Gateway intents

The bot's entire input channel is the text of messages in `#sessions` and its
threads, so it needs the privileged content intent. Developer Portal → **Bot**:

- [x] **Message Content Intent** — **ON**. Without it, every `message.content`
      arrives as an empty string and the bot appears alive but deaf.
- [ ] **Server Members Intent** — **OFF**. The operator allowlist is by user id
      from config; member records are not needed.
- [ ] **Presence Intent** — **OFF**. Nothing reads presence.
- [ ] **Public Bot** — **OFF**. This app must never be installable elsewhere.

Save changes, then restart the bot process — intents are negotiated at connect
time, not re-read live.

`GatewayIntentBits.MessageContent` is a **privileged** intent, and the gateway
**fails closed**: if the portal toggle is off while the client requests the
intent, the connection is closed during identify rather than degraded. The
diagnostic to look for in the bot's stderr is the phrase **disallowed
intents** — discord.js surfaces it as
`Error [DisallowedIntents]: Privileged intent provided is not enabled or whitelisted.`
Seeing that means the portal toggle, not the code, is wrong.

## 3. Token and operator allowlist on this workstation

### 3.1 Token file

Path: `%USERPROFILE%\.config\cloudcastle\devbot\discord-token` — the **same**
file the archive slice uses.

**It already exists on this box, empty and locked.** It was created and its DACL
set on 2026-08-27, and the loader's owner-only guard was confirmed to accept it
with a dummy value that was then erased. So the only step left is the paste:

> Open `%USERPROFILE%\.config\cloudcastle\devbot\discord-token` in an editor,
> paste the token as the **only** content, save, close.

Do not echo it into the file from a shell — it lands in PowerShell history. A
trailing newline is fine; the loader trims whitespace.

If you ever need to recreate it, note that `RUNBOOK-CREATE-APP.md` §4 grants
`:R`, which is right for a file that already holds the token but makes the paste
itself fail. Grant modify instead, then paste:

```powershell
$dir = "$env:USERPROFILE\.config\cloudcastle\devbot"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$token = "$dir\discord-token"
New-Item -ItemType File -Force -Path $token | Out-Null

# Strip inherited access; grant modify to only you, so you can still paste.
icacls $token /inheritance:r /grant:r "$($env:USERNAME):(M)"
```

Verify the lockdown:

```powershell
icacls "$env:USERPROFILE\.config\cloudcastle\devbot\discord-token"
```

You should see only your own account, plus `NT AUTHORITY\SYSTEM` and
`BUILTIN\Administrators` (the Windows equivalent of POSIX `root`, and
accepted). If `Everyone`, `Authenticated Users`, or `BUILTIN\Users` appears,
rerun the `icacls` line. On this box it currently reads exactly
`CHIMPPC\mikey:(M)`, which the guard accepts.

If you reset the token in the portal for any reason, the old one dies
immediately and the running bot drops off Discord. Rewrite the file and restart.

### 3.2 Environment

These are the exact variable names the implementation reads. There are no
others; anything else you find in a shell profile is stale.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `CC_DEVBOT_TOKEN_FILE` | no | `%USERPROFILE%\.config\cloudcastle\devbot\discord-token` | Override for the token path above. |
| `CC_DEVBOT_OPERATORS` | **yes** | — | Comma-separated Discord user ids allowed to drive sessions. |
| `CC_DEVBOT_WORKSPACES` | **yes** | — | Comma-separated `name=absolute-path` pairs; the only roots a session may run in. |
| `CC_DEVBOT_DEFAULT_WORKSPACE` | no | first entry of `CC_DEVBOT_WORKSPACES` | Which workspace a bare prompt uses. |
| `CC_DEVBOT_MODEL` | no | agent default | Model for new sessions; passed straight to `--model`. |
| `CC_DEVBOT_APPROVAL_MODE` | no | `yolo` | One of `always-ask` \| `write` \| `yolo`. |
| `CC_DEVBOT_MAX_SESSIONS` | no | `3` | Cap on concurrent agent child processes. |
| `CC_DEVBOT_IDLE_TIMEOUT_MS` | no | `1800000` (30 min) | Idle reap window for an agent child process. |
| `CC_DEVBOT_TURN_TIMEOUT_MS` | no | `1800000` (30 min) | Per-turn ceiling. |
| `CC_DEVBOT_STATE_DIR` | no | `%USERPROFILE%\.config\cloudcastle\devbot\state` | Directory for the thread→session map. |

Notes that will bite you otherwise:

- **`CC_DEVBOT_OPERATORS`** is an id allowlist, not a username allowlist.
  Anyone not on it is **ignored silently** — no error message in the channel,
  because an error message is itself a reply to an untrusted stranger. To get
  your id: Discord → **Settings → Advanced → Developer Mode ON**, then
  right-click your name → **Copy User ID**. It is a 17–20 digit snowflake. Do
  this for both founders and put both ids in.
- **`CC_DEVBOT_WORKSPACES`** is the sandbox boundary, such as it is. A session
  can only ever be started in one of the named roots; an unknown workspace name
  is **refused**, not guessed at. Example for this box:

  ```
  cloudcastle=C:\Users\mikey\Documents\CloudCastle,chudcode=C:\Users\mikey\Documents\chudcode
  ```

  Use absolute paths. Do not point a workspace at `C:\Users\mikey` or anything
  that contains the `.config\cloudcastle` directory from §3.1 — that would put
  the bot's own token inside a tree the agent can read and edit.
- **`CC_DEVBOT_MODEL`** is passed through to `--model` verbatim, so the agent's
  fuzzy resolution applies and short names like `opus` work.
- **`CC_DEVBOT_MAX_SESSIONS`** defaults to `3` because each session is a real
  child process holding a checkout; three concurrent agents on this i5-13400F
  is the point where builds start contending. Raise it only if you have
  measured.
- **`CC_DEVBOT_IDLE_TIMEOUT_MS`** and **`CC_DEVBOT_TURN_TIMEOUT_MS`** are
  distinct: the first reaps a session nobody has spoken to, the second aborts a
  single turn that will not end. Both default to 30 minutes.

Setting them for the current terminal:

```powershell
$env:CC_DEVBOT_OPERATORS = "<mikey-user-id>,<hunter-user-id>"
$env:CC_DEVBOT_WORKSPACES = "cloudcastle=C:\Users\mikey\Documents\CloudCastle,chudcode=C:\Users\mikey\Documents\chudcode"
$env:CC_DEVBOT_DEFAULT_WORKSPACE = "cloudcastle"
$env:CC_DEVBOT_APPROVAL_MODE = "yolo"
```

Persisting them for your user, so Task Scheduler (§4) sees them too:

```powershell
[Environment]::SetEnvironmentVariable("CC_DEVBOT_OPERATORS", "<mikey-user-id>,<hunter-user-id>", "User")
[Environment]::SetEnvironmentVariable("CC_DEVBOT_WORKSPACES", "cloudcastle=C:\Users\mikey\Documents\CloudCastle,chudcode=C:\Users\mikey\Documents\chudcode", "User")
[Environment]::SetEnvironmentVariable("CC_DEVBOT_DEFAULT_WORKSPACE", "cloudcastle", "User")
[Environment]::SetEnvironmentVariable("CC_DEVBOT_APPROVAL_MODE", "yolo", "User")
```

`"User"`-scope variables are only picked up by processes started **after** they
are set; restart the terminal.

### 3.3 Read this before you set `CC_DEVBOT_APPROVAL_MODE=yolo`

`yolo` is the default, and it is the whole reason unattended operation works:
in `always-ask` the agent stops at the first tool call and waits for a human
who is at work and not looking at Discord, so the session simply hangs. `write`
still gates command execution. `yolo` gates nothing.

Say it without euphemism: **`yolo` means every id in `CC_DEVBOT_OPERATORS` has
arbitrary code execution on this workstation, as your Windows user, triggered
by typing into a Discord message box.** The agent can read any file the user
can read, write any file the user can write, and run any program the user can
run. The workspace list restricts where a *session* is rooted; it does not
sandbox the filesystem, the network, or the credentials sitting in your user
profile.

Therefore:

- **The operator allowlist is the only control.** There is no second factor. A
  compromised Discord account belonging to an operator is a compromised
  workstation. Keep the list to the two founders. Do not add a third person
  "temporarily", and do not add a bot or a webhook id.
- **Discord can read the message content**, and so can anyone who later gains
  access to either founder's Discord account or session. Do not paste secrets,
  tokens, or customer data into `#sessions`. Treat that channel as a
  semi-public log of everything you asked the machine to do.
- **The outbound secret screener is best-effort.** It reduces the chance a key
  from the repo gets echoed into Discord; it does not prevent it. See §6.
- If you want a materially safer posture at the cost of responsiveness, use
  `CC_DEVBOT_APPROVAL_MODE=write` and accept that some sessions will stall
  until you get home.

## 4. Starting the bot

From `C:\Users\mikey\Documents\chudcode`:

```powershell
bun install
bun run --cwd=packages/cloudcastle-discord-bot devbot
```

The first line is only needed after a checkout or a dependency change. On
startup the bot logs the guild it connected to, the operator ids it loaded, and
the workspaces it resolved — read that line once and confirm the workspace
paths actually exist, because a typo'd path fails at session start, not at boot.

### Prove the agent half first, without Discord

Every failure worth debugging except the gateway itself — agent spawn, RPC
handshake, provider auth, model resolution, turn settlement — is reachable
without a token. Run it before you go looking at Discord:

```powershell
bun run --cwd=packages/cloudcastle-discord-bot devbot-smoke
```

It needs only `CC_DEVBOT_WORKSPACES`. It spawns one real agent in the default
workspace, runs one trivial prompt, prints the exact status block, answer, and
footer a Discord thread would have shown, then tears the child down and forgets
the session. Exit `0` means the whole agent half works; `2` means the turn ran
but did not complete; `1` is a configuration or spawn failure.

Point it at real work with `-- --prompt "…"` and `-- --workspace chudcode`.

Observed on this workstation, 2026-08-27: agent up in 1.3–2.8 s, a two-tool
turn (`read` + `bash`) settling in 6 s. A resume check across two separate
pools reopened the same session id and recalled a fact from the earlier turn,
which is the property `CC_DEVBOT_STATE_DIR` exists to hold.

### It only works while the process is running

The bot holds an **outbound** websocket to Discord's gateway. That has two
consequences, one good and one annoying:

- **Good:** there is no inbound anything. No port forwarding, no firewall rule,
  no public IP, no tunnel, no exposed service on your home network. The
  workstation reaches out; Discord never reaches in.
- **Annoying:** there is no server to fall back on. Close the terminal, log
  out, reboot, or let the machine sleep, and the bot is gone. Discord shows it
  offline and your messages in `#sessions` go unanswered with no error.

### Autostart at logon (Task Scheduler)

```powershell
$bun = (Get-Command bun).Source
$action = New-ScheduledTaskAction -Execute $bun `
  -Argument "run --cwd=packages/cloudcastle-discord-bot devbot" `
  -WorkingDirectory "C:\Users\mikey\Documents\chudcode"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "CloudCastle Dev Bot" `
  -Action $action -Trigger $trigger -Settings $settings `
  -Description "chudcode session bot; holds outbound websocket to Discord"
```

`-WorkingDirectory` must be the chudcode checkout — `--cwd` in the argument is
relative to it. `-ExecutionTimeLimit ([TimeSpan]::Zero)` disables the default
three-day kill. Run it under **your own user account, not SYSTEM**: the token
file's DACL from §3.1 grants read to you only, and `"User"`-scope environment
variables do not exist for SYSTEM.

Check it and read the logs:

```powershell
Get-ScheduledTask -TaskName "CloudCastle Dev Bot" | Get-ScheduledTaskInfo
Start-ScheduledTask -TaskName "CloudCastle Dev Bot"
```

A scheduled task's console output is not captured anywhere by default. If you
need the stderr that §6 keeps asking for, append a redirect to the argument
string or run it in a visible terminal while debugging.

**Simpler alternative:** leave a Windows Terminal tab open running the two
commands above. Entirely legitimate for a two-person team, and it means the
stderr is right there. It just does not survive a reboot.

### Sleep will take the bot offline

If the workstation is expected to answer Discord while you are at work, sleep
and hibernate must be off. On AC power:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 15
```

`0` means never. The monitor line is separate and can stay short — turning off
the display does not suspend the process. Confirm with `powercfg /query` or
just `powercfg /a` to see which sleep states are still available. Note that
this is a desktop with a discrete GPU: leaving it awake all day is a power
cost, not a battery risk.

## 5. Using it from Discord

Everything happens in `#sessions` (`1542631105608556574`) and the threads it
spawns. There are no slash commands to register.

**Start a session** — post a message in `#sessions`. The bot creates a public
thread named from your prompt and starts an agent session in the default
workspace (`CC_DEVBOT_DEFAULT_WORKSPACE`, else the first entry in
`CC_DEVBOT_WORKSPACES`).

**Pick a workspace** — prefix with `workspacename:`. For example:

```
chudcode: why is the RPC ready frame racing?
```

An unknown name is refused rather than silently falling back, so a typo tells
you instead of running against the wrong checkout.

**Continue a session** — any message you post in a session thread is the next
prompt for that session. If the agent is **mid-turn**, your message is
**steered into the running turn** rather than queued behind it — so you can
course-correct an agent that is heading the wrong way without aborting it. If
the agent is idle, it starts a new turn.

**Control commands**, in-thread, all prefixed `!`:

| Command | Effect |
|---|---|
| `!abort` | Stop the current turn. Session stays alive for the next prompt. |
| `!end` | Terminate the session and its child process; frees a `CC_DEVBOT_MAX_SESSIONS` slot. |
| `!status` | Workspace, model and thinking level, session id, message and tool counts, context use, cumulative cost, and whether a turn is running. |
| `!model <name>` | Switch model for this session; fuzzy names work. |
| `!compact` | Force a context compaction now instead of waiting for the automatic one. |
| `!new` | End this session and start a fresh one in the same thread, same workspace. |
| `!help` | The command list, in-thread. |

**Acknowledgement** — the bot adds a reaction to any message it accepted. This
is the phone-screen affordance: a reaction means received and being worked;
no reaction after a few seconds means the bot is offline, you are not on the
operator allowlist, or you posted somewhere it does not listen.

**Output shape** — progress is a **single status message edited in place every
few seconds** (tool calls, turn boundaries, retries), so the thread does not
fill with noise. When the turn ends, the final answer is posted as one or more
messages, and anything too long for Discord's message limit is attached as a
`.md` file instead of being chopped.

**Live token-by-token streaming is not implemented, and is not the goal.**
Batched status edits every few seconds is the intended behaviour, not a
placeholder for streaming. Discord rate-limits message edits, and a
token-stream would spend the entire budget on rendering a cursor. Do not file
this as a bug.

## 6. Failure modes and what to check

| Symptom | Likely cause | Fix |
|---|---|---|
| Bot never appears online; process exits at startup | Token file missing, empty, or wrong path | Confirm `%USERPROFILE%\.config\cloudcastle\devbot\discord-token` exists and holds only the token; check `CC_DEVBOT_TOKEN_FILE` if set (§3.1). |
| Bot never appears online; stderr says **disallowed intents** | Message Content Intent is OFF in the portal | Turn it ON (§2) and restart the process — intents are negotiated at connect. |
| Bot never appears online; stderr says unauthorized / 401 | Token was reset in the portal after the file was written | Reveal a new token, rewrite the file, restart. |
| Process refuses to start, complains about config | `CC_DEVBOT_OPERATORS` or `CC_DEVBOT_WORKSPACES` unset | Both are required (§3.2). `"User"`-scope vars need a fresh terminal. |
| Bot online, reacts to nothing, says nothing | Your user id is not in `CC_DEVBOT_OPERATORS` | Non-operators are ignored silently by design. Copy your id via Developer Mode and add it; restart. |
| Bot online, silent in `#sessions` specifically | Posting in the wrong channel | It listens in `1542631105608556574` and its threads, nothing else. |
| Bot reacts but no thread or no message appears | Missing Send Messages / Create Public Threads / Send Messages in Threads — the re-invite in §1 was skipped, or a channel override denies them | Re-visit the authorize URL with `326417632320`; then check Channel Settings → Permissions on `#sessions` for an override, which beats the role. |
| Thread is created, then nothing at all | The agent child process failed to spawn — bad workspace path, missing `bun`, agent binary not resolvable | **Read the bot's stderr.** The spawn error is only there, never in Discord. Confirm each `CC_DEVBOT_WORKSPACES` path exists. |
| "Too many sessions" / new prompts refused | `CC_DEVBOT_MAX_SESSIONS` (default `3`) reached | `!end` a finished thread, or wait for `CC_DEVBOT_IDLE_TIMEOUT_MS` (default 30 min) to reap it. |
| Turn starts and never finishes | `CC_DEVBOT_TURN_TIMEOUT_MS` (default 30 min) hit, or a model-provider outage/rate-limit stalling retries | `!abort`, then `!status`. Check the provider's status page before blaming the bot; retries are logged to stderr. |
| Session vanished on its own | Idle longer than `CC_DEVBOT_IDLE_TIMEOUT_MS` | Expected, and cheap: only the child process was reaped. Posting in the thread again **resumes the same transcript** from `CC_DEVBOT_STATE_DIR`, so context is not lost. Use `!new` when you actually want a clean transcript. |
| Duplicated or replayed output after a restart | Thread→session map in `CC_DEVBOT_STATE_DIR` is stale or was rebuilt against a thread whose child process no longer exists | Inspect `%USERPROFILE%\.config\cloudcastle\devbot\state` (or the `CC_DEVBOT_STATE_DIR` override); `!end` the affected thread to clear it. Deleting the state directory while the bot is stopped is safe and loses only the mapping. |
| A secret appears in a Discord message | The outbound secret screener missed it | Treat it as leaked: rotate the credential immediately. The screener is **best-effort, not a guarantee** — it pattern-matches, it does not understand. Do not rely on it, and never point a workspace at a directory holding credentials (§3.2). |

Two standing rules: **the stderr of the bot process is the only real log**, so
run it somewhere you can read it while debugging; and Discord-side problems
(permissions, intents) always look identical from the client — an app that is
online and doing nothing. Check the role before you read code.

## 7. What this runbook does not authorize

Nothing here changes the cutover position in `HANDOFF.md:155-166`. Specifically:

- Do **not** freeze or redirect any legacy channel.
- Do **not** remove Discmeet.
- Do **not** create the `cc-new-*` replacement layout.
- Do **not** delete a channel, thread, or message. Deletion remains
  owner-account browser work, leaf-first, with each source ID rechecked
  immediately before deletion.

The `326417632320` mask contains no deletion, channel-management, or
role-management bit, so the bot is not merely forbidden from these — it is
incapable of them, and it must stay that way (`HANDOFF.md:166`).

The archive gates are untouched by this bot. As of this writing **the initial
archive export still has not run**, no verification or classification report
exists, and the guild remains unmutated. Running sessions from Discord does not
advance those gates and must not be recorded as if it had.
