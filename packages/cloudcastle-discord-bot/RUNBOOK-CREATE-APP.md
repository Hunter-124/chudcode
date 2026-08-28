# Runbook — create the Discord app and run the first archive export

Operator procedure. `HANDOFF.md` is the state record; this is the click-by-click.
Every number below was independently re-derived, not copied.

The blocker this unblocks: Discord's Developer Portal repeatedly stopped Hunter at
its "Wait! Are you human?" challenge, so **no app, no token, and no export exist
yet**. Nothing in the CloudCastle guild has been mutated.

## 0. What you are creating, and what it can do

One Discord application, **CloudCastle Dev Bot**, installed into guild
`1542474553320542278` with a **read-only** permission set for the archive slice.

Permission integer: **`17179935744`**

Verified decomposition — this is exactly three bits and nothing else:

| Bit | Value | Permission |
|---|---|---|
| `1 << 10` | 1 024 | View Channels |
| `1 << 16` | 65 536 | Read Message History |
| `1 << 34` | 17 179 869 184 | Manage Threads (temporary; needed only to enumerate archived private threads) |

Sum = `17179935744`. Confirmed absent from that mask: Administrator,
Manage Channels, Manage Guild, Manage Messages, Manage Roles, Send Messages,
Ban Members, Kick Members, Mention Everyone.

The bot has **no send permission and no delete permission** during the archive
slice. That is deliberate: it cannot alter the thing it is evidencing. Deletion at
cutover stays owner-account browser work.

## 1. Get past the human-verification gate

The challenge is a Cloudflare turnstile. It fails closed when a browser blocks the
challenge frame, which is the most likely reason it stopped Hunter (his own PR
notes he was on Brave).

Try in this order, stopping when the portal loads:

1. Plain **Chrome**, normal window, no VPN or proxy active.
2. If you use Brave: **Shields down** for `discord.com`, or don't use Brave.
3. Disable ad-blocking / privacy extensions for `discord.com` and `cloudflare.com`.
4. Allow third-party cookies for the challenge — some blockers kill it silently.
5. Not an incognito window; the challenge is flakier without a warm profile.

Open <https://discord.com/developers/applications> and sign in as the account
that will **own** this app.

## 2. Create the application

1. **New Application** (top right).
2. Name it exactly: `CloudCastle Dev Bot`
3. Accept the developer terms **only as the account owner**.
4. On **General Information**, copy the **Application ID** and paste it into
   step 5's URL. Record it in `HANDOFF.md` when you're done.

## 3. Configure the bot user and intents

Left sidebar → **Bot**.

Enable exactly one privileged intent:

- [x] **Message Content Intent** — the export needs message bodies.
- [ ] **Server Members Intent** — leave **OFF**.
- [ ] **Presence Intent** — leave **OFF**.

Also on this page:

- **Public Bot** → **OFF**. This app must never be installable by anyone else.
- **Requires OAuth2 Code Grant** → OFF (leave default).

Save changes.

## 4. Reveal the token and write it to disk safely

Still on **Bot** → **Reset Token** → confirm → the token is shown **once**.

Do not paste it into a chat, a terminal, a commit, or a log. Create the file
first, then paste into an editor.

**Windows (this workstation):**

```powershell
$dir = "$env:USERPROFILE\.config\cloudcastle\devbot"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$token = "$dir\discord-token"
New-Item -ItemType File -Force -Path $token | Out-Null

# Strip inherited access and grant read to only you.
icacls $token /inheritance:r /grant:r "$($env:USERNAME):R"
```

Then open `%USERPROFILE%\.config\cloudcastle\devbot\discord-token` in an editor,
paste the token as the **only** content, save, and close. No trailing newline is
required; the loader trims whitespace.

Verify the lockdown took effect:

```powershell
icacls "$env:USERPROFILE\.config\cloudcastle\devbot\discord-token"
```

You should see only your own account (plus `NT AUTHORITY\SYSTEM` and
`BUILTIN\Administrators`, which are the Windows equivalent of POSIX `root` and are
accepted). If `Everyone`, `Authenticated Users`, or `BUILTIN\Users` appears, the
verifier will refuse to run — rerun the `icacls` line above.

> The Python verifier's permission gate used to be POSIX-only and was
> **unsatisfiable on Windows** (`os.stat` reflects only the read-only attribute,
> so the strictest achievable mode is `0o444` and `0o444 & 0o077` is non-zero).
> It now checks the NTFS DACL on Windows and POSIX mode bits elsewhere —
> `python/robomp/src/secret_file_guard.py`.

**POSIX (Hunter/Garrison):** unchanged from `HANDOFF.md:59-65`.

## 5. Install into the guild — and check the consent screen

Do **not** use the portal's URL generator; use this exact URL so the guild and the
permission mask cannot drift. Replace `<APPLICATION_ID>` only.

```
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=17179935744&guild_id=1542474553320542278&disable_guild_select=true
```

`disable_guild_select=true` pins the install to the CloudCastle guild so a
mis-click cannot install it elsewhere.

**Before pressing Authorize, confirm on the consent screen:**

- server shown is **CloudCastle** (`1542474553320542278`);
- the permission list is exactly **View Channels**, **Read Message History**,
  **Manage Threads** — three entries, nothing more;
- no "Administrator", no "Send Messages", no role-management entry.

If the list differs, stop and re-check the URL. Then Authorize.

## 6. Run the export

From `C:\Users\mikey\Documents\chudcode`:

```powershell
bun install --frozen-lockfile --filter @cloudcastle/discord-bot
bun run --cwd=packages/cloudcastle-discord-bot check
bun run --cwd=packages/cloudcastle-discord-bot test
```

Then the export itself. Note the destination differs from `HANDOFF.md:101`, which
hardcodes Hunter's Linux path:

```powershell
bun run --cwd=packages/cloudcastle-discord-bot export -- `
  --guild 1542474553320542278 `
  --out "C:\Users\mikey\CloudCastle\docs\meeting, 8-27\discord-server-export" `
  --before-mutate `
  --token-file "$env:USERPROFILE\.config\cloudcastle\devbot\discord-token"
```

Exit codes: **0** = clean; **2** = the manifest was written but a scope was
unreadable — that is a **blocker**, never a partial success; **1** = error.

Two notes specific to this workstation:

- **`--age-recipient-file` is only required if the secret screener finds
  redactions** (`archive.ts:234-235` throws in that case). If you hit that error,
  generate an age key pair per `HANDOFF.md:33-38` and re-run with the recipient
  file. The exporter shells out to an external `age` binary, which is **not
  installed here** — install it before re-running that path.
- `docs/meeting, 8-27/` **does not exist in the CloudCastle checkout** and never
  did (no commit in any branch ever touched it, and it is not gitignored). The
  four artifacts `HANDOFF.md:109-114` records hashes for — `#1.txt`, `#1-A.md`,
  `#2.txt`, `#2-A.md` — are absent, so those planning-time hashes cannot be
  re-verified from this box and `INDEX.md` will omit the "Pre-existing meeting
  artifacts" section. This degrades cleanly (`archive.ts:714-716` ignores
  `ENOENT`) and is not a blocker, but do not record it as if those files were
  preserved. If Hunter still holds them untracked, get them into the repo before
  the cutover so the migration evidence is complete.

## 7. Commit, verify, classify

Stage **only** `docs/meeting, 8-27/` — the CloudCastle checkout carries unrelated
work. Reconfirm the repo is still private before pushing.

Then run the independent verifier against the pushed SHA with
`DISCORD_TOKEN_FILE` set to the token path from step 4, followed by the
classifier. Both invocations are in `HANDOFF.md:124-153`. Every scope must be
`verified: true`, the commit must be an ancestor of `origin/main`, and every
message must end with exactly one terminal classification.

## 8. Do not cross this line

Do not freeze channels, remove Discmeet, create `cc-new-*`, or delete anything
until every gate in `HANDOFF.md:155-166` is green. The bot must never be granted
channel or role deletion power.
