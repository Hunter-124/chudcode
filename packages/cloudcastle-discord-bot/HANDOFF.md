# CloudCastle Discord development bot handoff

## Current state

The application EXISTS and its bot is installed in the guild. The
"Wait! Are you human?" narrative below is history, not a blocker: application
`1542714531409821726` was created on 2026-08-27 and its bot user
`cloudcastledevbot` is a member of guild `1542474553320542278`.

Landed and exercised against the live guild:

- the GET-only exporter in `src/archive.ts` and its `export` CLI, plus the
  independent Python verifier and classification gate under `python/robochud/`;
- `src/channels.ts` — the typed channel map and the target layout;
- `src/bridge-protocol.ts` — the session/bus wire contract;
- `src/discord-rest.ts` — bot-token REST with no delete method, by construction;
- `src/session-scan.ts` / `src/session-render.ts` — the on-disk chudcode session
  store turned into snapshots and Discord embeds;
- `src/bus.ts`, `src/cc-agent.ts`, `src/cc-gateway.ts` — one Discord CHANNEL per
  chudcode session, created by `/new` and named from the session title, with
  `/session list|say|interrupt|stop|tail`. Threads were built first and rejected
  by the team: a thread hides its content behind a click.
- `src/provision.ts` and `src/condense.ts` — drive the guild to the target layout
  and fold the archive into proposed GitHub issues.

172 tests pass in this package. The archive export has RUN: 15 scopes, 61
messages, written under `docs/meeting, 8-27/discord-server-export/` in the
CloudCastle repository.

Still true, and still the governing constraint: **no guild channel, role,
thread or message has been deleted, frozen or redirected, and Discmeet is
untouched.** The cutover gate below remains in force. `provision` never issues a
DELETE — `assertNoDeletes` makes that structural rather than a promise.

### The two things that are actually blocking, both one human click

1. **The `MESSAGE_CONTENT` privileged intent is OFF.** `GET /applications/@me`
   returns `flags: 0`. Consequence, verified rather than assumed: every
   `GET /channels/{id}/messages` returns `content: ""`. The export therefore
   preserved 61 messages of metadata with **zero message bodies**, so it is not
   yet the preservation artifact the cutover gate requires, and both `condense`
   and `provision --flatten-threads` deliberately refuse rather than invent
   content. Enable it at Developer Portal -> Applications ->
   `1542714531409821726` -> Bot -> Privileged Gateway Intents, then re-run the
   export.
2. **Three permissions are missing.** Effective guild permissions are
   `2248473465835073`, inherited entirely from `@everyone`; the bot's own role
   adds nothing. `MANAGE_CHANNELS` (bit 4), `MANAGE_MESSAGES` (13) and
   `MANAGE_THREADS` (34) are absent, which is why pinning answers 403/50013 and
   `enumerate_archived_private_threads` answers 403/50001 on all eleven text
   channels. Note that the archive-only permission integer recorded further down
   this file, `17179935744`, already included `MANAGE_THREADS`; the install was
   made without it. Re-invite with `permissions=328565124176`.

Everything else works now: posting, editing a message in place, creating a
channel's first message, adding a reaction, and reading message history as
metadata were all exercised against the real guild.

## Local secret material

Hunter's workstation has an age identity and recipient under:

- private identity: `~/.config/cloudcastle/devbot/archive.agekey` (`0600`);
- public recipient file: `~/.config/cloudcastle/devbot/archive-recipient.txt` (`0600`).

These files are intentionally outside Git. A different operator may generate a replacement pair:

```bash
install -d -m 700 ~/.config/cloudcastle/devbot
age-keygen -o ~/.config/cloudcastle/devbot/archive.agekey
age-keygen -y ~/.config/cloudcastle/devbot/archive.agekey > ~/.config/cloudcastle/devbot/archive-recipient.txt
chmod 600 ~/.config/cloudcastle/devbot/archive.agekey ~/.config/cloudcastle/devbot/archive-recipient.txt
```

Never commit the bot token, age identity, raw transcript/audio, or an unscreened export.

## Resume at the Discord Developer Portal

Create a blank application named **CloudCastle Dev Bot** under the owning Discord account. Accept Discord's developer terms only as the account owner. Record the application ID.

For the initial archive-only install:

1. Enable only the privileged `MESSAGE_CONTENT` intent.
2. Do not enable `GUILD_MEMBERS` or `GUILD_PRESENCES`.
3. Install only into guild `1542474553320542278` (`CloudCastle`).
4. Grant only:
   - View Channels;
   - Read Message History;
   - temporary Manage Threads, solely for archived private-thread discovery.
5. Do not grant Administrator, Manage Channels, Manage Roles, Manage Messages, Ban Members, or any send permission during the archive slice.

The archive-only permission integer is `17179935744`. Verify the app name, application ID, guild ID, and displayed permission list before authorizing.

Write the one-time token directly to a non-repository file and lock it down:

```bash
install -d -m 700 ~/.config/cloudcastle/devbot
install -m 600 /dev/null ~/.config/cloudcastle/devbot/discord-token
# Paste the token into that file without printing it in shell history or logs.
```

## Migration source inventory

Guild: `1542474553320542278`

- root: `milestones` `1542614939540263073`, `updates` `1542626782639824916`;
- `talk` `1542474554012864572`:
  - `chat` `1542626296012472360`;
  - `documents` `1542626326362460200`;
  - `meeting-transcripts` `1542474554012864574`;
  - voice `meeting` `1542474554012864575`;
- `task planning & delegation` `1542614463784558744`:
  - `que` `1542626072405868664`;
  - `problems` `1542614440602771476`;
  - `priority-task-list` `1542614871772893244`;
  - `git` `1542615109686263899`;
- `chudcode` `1542625972111806574`: `sessions` `1542631105608556574`;
- `WIP` category `1542629926941761536`;
- known threads:
  - `Equity Structure & Funding Strategy` `1542493184423239750`;
  - `Simplify Admin Console, Finalize Pricing & Prep Product Launches` `1542489253051895889`;
  - `Test of Audio Setup` `1542475506270871612`.

`/bootstrap dry-run` must revalidate every ID before any future cutover.

## Run the initial export

From `/home/hunter/Repositories/chudcode`:

```bash
bun install --frozen-lockfile --filter @cloudcastle/discord-bot
bun run --cwd=packages/cloudcastle-discord-bot check
bun run --cwd=packages/cloudcastle-discord-bot test
bun run --cwd=packages/cloudcastle-discord-bot export -- \
  --guild 1542474553320542278 \
  --out '/home/hunter/Desktop/CloudCastle/docs/meeting, 8-27/discord-server-export' \
  --before-mutate \
  --token-file ~/.config/cloudcastle/devbot/discord-token \
  --age-recipient-file ~/.config/cloudcastle/devbot/archive-recipient.txt
```

Exit code `2` means the exporter wrote evidence but found an unreadable scope. Treat that as a blocker, never as a partial success.

The exporter preserves the four pre-existing meeting artifacts in place and records these planning-time hashes:

- `#1.txt`: `d518bc44896eadef11bff7d670a023f71f05f3605ddd6ada8a2d5943c7175166`;
- `#1-A.md`: `f0b18f1537d7d9c3e155e0834635b0f5d11c7969534a9f26041abf00c5e57563`;
- `#2.txt`: `ed32e5d127bb4b88148e715a42702fe960b2878f112351d1b28127741a65e72f`;
- `#2-A.md`: `30a6ef6643d01f4de76bda6a599aa273632918d6dfd19fc7bdc78eb7eed29e9b`.

Never rewrite or renumber those files. If `Test of Audio Setup` contains messages, create `#3.txt` and `#3-A.md` and map both to thread `1542475506270871612` in `INDEX.md`.

## Commit, verify, and classify before mutation

The CloudCastle repository is private (`Hunter-124/CloudCastle`, viewer permission ADMIN as observed on 2026-08-27). Reconfirm visibility immediately before pushing the export. Stage only `docs/meeting, 8-27/` because the checkout had extensive unrelated work.

After pushing the export commit, fetch `origin/main` and run the independent verifier against the pushed SHA. It rereads every manifest/blob with `git show`, independently enumerates live channels and active/archived public/private/joined-private threads, compares exact message-ID sets, and re-downloads attachments for SHA-256 comparison.

```python
import asyncio
from pathlib import Path
from robochud.discord_archive_verify import verify_export

report = asyncio.run(verify_export(
    guild_id="1542474553320542278",
    export_dir=Path("/home/hunter/Desktop/CloudCastle/docs/meeting, 8-27/discord-server-export"),
    commit_sha="<pushed-export-sha>",
    cutoff_by_channel=None,
))
print(report.to_dict())
raise SystemExit(0 if report.verified else 1)
```

Set `DISCORD_TOKEN_FILE=~/.config/cloudcastle/devbot/discord-token` for that process. Every scope must be `verified:true`; the commit must be an ancestor of `origin/main`; unresolved 403/404/Unknown Message responses are fatal.

Then classify every archived message. The honest default is `context_only`; overrides may use only `addressed`, `in_progress`, `proposed`, `superseded`, or `context_only`.

```python
from pathlib import Path
from robochud.discord_archive_classify import classify_export

report = classify_export(
    export_dir=Path("/home/hunter/Desktop/CloudCastle/docs/meeting, 8-27/discord-server-export"),
    export_commit_sha="<pushed-export-sha>",
    overrides={},
)
print(report)
```

## Hard cutover gate

Do not freeze, redirect, remove Discmeet, create replacement channels, or delete anything until all of these are true:

- initial export is pushed;
- independent verification is green for every scope and attachment;
- every message has one terminal classification;
- the replacement Discord adapter, coordinator, worker, GitHub projection, and recorder exist and pass their own tests;
- the replacement layout has passed text/thread/voice smoke;
- a final-delta export is pushed and independently reverified with zero post-cutoff messages.

Deletion remains owner-account browser work, leaf-first, and each source ID must be rechecked immediately before deletion. The bot must never receive channel/role deletion power.

## Remaining implementation order

1. Add the fenced development-task schema/dispatcher and signed worker APIs to `python/robochud`.
2. Add the outbound multi-host RPC worker around the installed Chudcode binary.
3. Expand this package with the least-privilege Gateway adapter and patched DAVE voice receive path.
4. Add Discord provenance ingestion and approved-only GitHub Issue/Project projection.
5. Add founder-only `/burn` with quota fingerprinting and explicit stop semantics.
6. Add per-speaker local transcription, flat document publication, retention, and participant deletion.
7. Add public privacy policy and prove the URL before recording can start.
8. Use the owner account to build the temporary `cc-new-*` layout, smoke it, seal the final delta, and only then cut over.
9. Deploy coordinator/adapter/gh-proxy and enroll the three exact outbound workers.

The live cutover intentionally remains unstarted until another owner can complete Discord's human-verification gate.
