# CloudCastle Discord development bot handoff

## Current state

The safe archive foundation is on `main` in commit `203cb96932` (`feat: add verified Discord archive tooling`). It contains:

- a GET-only Discord exporter in `src/archive.ts`;
- the `export` CLI in `src/export-cli.ts`;
- an independent Python verifier in `python/robomp/src/discord_archive_verify.py`;
- a terminal-classification gate in `python/robomp/src/discord_archive_classify.py`;
- focused TypeScript and Python contract tests.

The Discord application was **not created**. Discord's Developer Portal repeatedly stopped both Hunter and the operator at its broken “Wait! Are you human?” challenge. Therefore:

- no Discord bot token exists;
- no app was installed into the CloudCastle guild;
- no guild permissions, roles, channels, threads, or messages were changed;
- no archive export has run;
- Discmeet was not removed;
- no legacy channel was frozen or deleted.

This is a clean handoff, not a partial live cutover.

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

From `/home/hunter/Repositories/omp`:

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
from robomp.discord_archive_verify import verify_export

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
from robomp.discord_archive_classify import classify_export

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

1. Add the fenced development-task schema/dispatcher and signed worker APIs to `python/robomp`.
2. Add the outbound multi-host RPC worker around the installed OMP binary.
3. Expand this package with the least-privilege Gateway adapter and patched DAVE voice receive path.
4. Add Discord provenance ingestion and approved-only GitHub Issue/Project projection.
5. Add founder-only `/burn` with quota fingerprinting and explicit stop semantics.
6. Add per-speaker local transcription, flat document publication, retention, and participant deletion.
7. Add public privacy policy and prove the URL before recording can start.
8. Use the owner account to build the temporary `cc-new-*` layout, smoke it, seal the final delta, and only then cut over.
9. Deploy coordinator/adapter/gh-proxy and enroll the three exact outbound workers.

The live cutover intentionally remains unstarted until another owner can complete Discord's human-verification gate.
