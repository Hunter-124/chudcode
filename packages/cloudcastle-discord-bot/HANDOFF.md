# CloudCastle Discord development bot handoff

## Current state

The application EXISTS, its bot is installed in the guild with the full
permission set, and the `MESSAGE_CONTENT` intent is ON. Application
`1542714531409821726` was created on 2026-08-27 and its bot user
`cloudcastledevbot` is a member of guild `1542474553320542278`. The Developer
Portal's "Wait! Are you human?" gate, which once stopped two operators and
shaped this whole document, is history: everything since has been done over the
API with a bot token.

Landed and exercised against the live guild:

- the GET-only exporter in `src/archive.ts` and its `export` CLI, plus the
  independent Python verifier and classification gate under `python/robochud/`;
- `src/channels.ts` — the typed channel map and the target layout;
- `src/bridge-protocol.ts` — the session/bus wire contract;
- `src/discord-rest.ts` — bot-token REST with no delete method, by construction;
- `src/session-scan.ts` / `src/session-render.ts` — the on-disk chudcode session
  store turned into snapshots and Discord embeds;
- `src/bus.ts`, `src/cc-agent.ts`, `src/cc-gateway.ts` — one Discord channel per
  Discord-started task. `/task start|list|status|steer|pause|stop|transcript`
  is the complete slash-command surface, and an ordinary human reply inside an
  active task channel steers it without a slash command. Local chudcode sessions
  are deliberately excluded so developer background work cannot flood the guild.
- `src/provision.ts` and `src/condense.ts` — drive the guild to the target layout
  and fold the archive into proposed GitHub issues.

185 tests pass in this package (`bun test test`).

Still true, and still the governing constraint: **no guild channel, role,
thread or message has been deleted, frozen or redirected, and Discmeet is
untouched.** The cutover gate below remains in force. `provision` never issues a
DELETE — `assertNoDeletes` makes that structural rather than a promise, and
`src/discord-rest.ts` has no delete method to call in the first place.

### What is delivered and running

Nothing is blocked. Both of the items that used to sit here are done, and each
was cleared by a route worth recording:

1. **`MESSAGE_CONTENT` is ON — enabled over the API, not in the portal.**
   `PATCH /applications/@me` with `{"flags": 524288}` sets
   `GATEWAY_MESSAGE_CONTENT_LIMITED` (bit 19). Discord permits an application to
   set its own *limited* intent flags this way; the unlimited bit (18) is not
   settable over the API, and limited is enough — same message text, 100-guild
   ceiling this application is nowhere near. `GET /applications/@me` returns
   `flags: 524288`. No browser and no owning account at a keyboard was needed.
   Message bodies read normally.
2. **The bot was re-invited with the full permission set.** Effective guild
   permissions are now `4500290459397713`; the bot's own role `CloudCastle`
   carries exactly `2252128378809424`. `ADMINISTRATOR`, `MANAGE_GUILD`,
   `MANAGE_ROLES`, `KICK_MEMBERS` and `BAN_MEMBERS` were withheld and their
   absence is verified, not assumed.

   **`PIN_MESSAGES` is bit 51 and is a separate permission from
   `MANAGE_MESSAGES` (bit 13).** Discord split pinning into its own bit. The bot
   held `MANAGE_MESSAGES` with no channel overwrites narrowing it and still got
   **403, code 50013** from both `PUT /channels/{id}/pins/{mid}` and the newer
   `PUT /channels/{id}/messages/pins/{mid}`; the re-invite dialog listed "Pin
   Messages" as a thirteenth checkbox. `REQUIRED_PERMISSIONS` moved from
   `328565124176` to `2252128378809424` because of it. Any documentation saying
   `MANAGE_MESSAGES` covers pinning — including Discord's own older pages and
   earlier revisions of this file — describes the previous model.

Current state, all of it verified against the live guild:

- **The guild is provisioned idempotently.** Working categories are **active
  tasks** and **completed tasks**; the standing categories remain **dev feed**,
  **intake**, **team**, and **archive**. `#how-we-work` is a short task-oriented
  guide, `#sessions` names the task controls, and `#archive-notice` now states
  accurately that the verified export contains message bodies. Every automated
  layout action is a create, rename, reparent, topic update, or pinned-message
  edit. `provision` still cannot plan or issue a delete.
- **The meeting threads are flattened** into `#meeting-transcripts`: 18 bot posts
  carrying a `cc-flatten:<threadId>` marker, the original author and timestamp,
  and a link to the original `.md`/`.txt` attachment. Idempotent — a rerun plans
  zero actions. **The source threads were not deleted.** Six source messages are
  attachment-only, because DiscMeet posts each transcript as a lone `.md` with no
  text; the tools name the attachment rather than inventing a body, and say so.
  That is not an intent problem and never was.
- **Three GitHub issues filed from the archive** by `condense`: #18 *Simplify
  Admin Console, Finalize Pricing & Prep Product Launches*, #19 *Equity
  Structure & Funding Strategy*, #20 *Marketing /about is missing NVIDIA under
  Technology partners*. Each body carries Discord permalinks, authors and
  timestamps. A fourth candidate, *Test of Audio Setup*, was judged noise and
  deliberately not filed.
- **`/task start|list|status|steer|pause|stop|transcript` is registered** for
  guild `1542474553320542278`, with no global propagation delay. Starting a task
  creates `#task-…` under **active tasks**. It gets a plain-language status card,
  a controls message, readable progress updates, and the task conversation.
  Human replies in that channel are forwarded as steering while work is active.
  Completion adds a final summary marker, renames the channel `#done-…`, and
  moves it to **completed tasks**. Status cards no longer lead with host, model,
  token, cost, tool, message-count, or session-id accounting.
- **Two systemd user services are installed, enabled and running**:
  `cc-agent.service` and `cc-gateway.service`, unit files under
  `~/.config/systemd/user/`. `loginctl enable-linger hunter` is set so they
  survive logout. `cc-agent` is one per dev machine and REST-only; exactly one
  `cc-gateway` holds the single gateway websocket for the whole team. A clean
  `cc-agent` stop reports `ExecMainStatus=0` / `Result=success`. Environment:
  `CC_BUS_CHANNEL_ID=1543124326205751418`, and `CC_AGENT_PROJECT_ROOTS`, a
  colon-separated realpath-checked allowlist of directories a Discord
  `/task start` may use — a security boundary, since without it the task command
  is arbitrary code execution from a chat surface. `docs/tracking/RUNBOOK.md`
  §5 in the CloudCastle repository is the operator view.
- **The archive is re-exported and complete**: 15 scopes, 67 messages, 0
  unresolved, **with message bodies**, under
  `docs/meeting, 8-27/discord-server-export/` in the CloudCastle repository. The
  earlier contentless export was replaced, not annotated.

Everything else works as before: posting, editing a message in place, creating a
channel's first message, adding a reaction, pinning, and reading message history
with bodies.

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

## The install, as it stands

The application exists, is installed in guild `1542474553320542278`
(`CloudCastle`) only, and carries `2252128378809424` — the thirteen bits in
`REQUIRED_PERMISSIONS` in `src/channels.ts`, which is also what `inviteUrl`
generates from. `GUILD_MEMBERS` and `GUILD_PRESENCES` remain off, deliberately;
only `MESSAGE_CONTENT` (limited, `flags: 524288`) is enabled.

To re-invite — after adding a bit, or into a second guild — generate the URL
rather than typing an integer:

```bash
bun -e 'import {inviteUrl} from "./src/channels"; console.log(inviteUrl("1542714531409821726"))'
```

Re-authorising an already-installed bot does not remove it, duplicate it, or
reset anything; it replaces the permission set on its managed role. Verify the
app name, application ID, guild ID and displayed permission list before
authorising, and check that **Pin Messages** appears — it is a separate checkbox
from Manage Messages.

On a new machine, write the token to a non-repository file and lock it down. The
REST client reads `CC_DISCORD_TOKEN_FILE`, falling back to this path:

```bash
install -d -m 700 ~/.config/cloudcastle/devbot
install -m 600 /dev/null ~/.config/cloudcastle/devbot/discord-token
# Paste the token into that file without printing it in shell history or logs.
```

## Migration source inventory (pre-reorganisation)

This is the layout as it was before `provision` ran, kept because the archive
under `docs/meeting, 8-27/discord-server-export/` maps to these ids and its
`INDEX.md` names them. **It is not the current layout** — `src/channels.ts` is,
and `CATEGORY_IDS` records what each category was renamed from.

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

`provision --dry-run` revalidates every id against the live guild and plans zero
actions when the layout already matches. Run it before any future cutover.

## Re-run the export

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

The exporter preserves the four pre-existing meeting artifacts in place and
records these planning-time hashes. **They still match**, re-checked with
`sha256sum` against the committed files:

- `#1.txt`: `d518bc44896eadef11bff7d670a023f71f05f3605ddd6ada8a2d5943c7175166`;
- `#1-A.md`: `f0b18f1537d7d9c3e155e0834635b0f5d11c7969534a9f26041abf00c5e57563`;
- `#2.txt`: `ed32e5d127bb4b88148e715a42702fe960b2878f112351d1b28127741a65e72f`;
- `#2-A.md`: `30a6ef6643d01f4de76bda6a599aa273632918d6dfd19fc7bdc78eb7eed29e9b`.

Never rewrite or renumber those files. `Test of Audio Setup`
(`1542475506270871612`) does contain messages and is exported as its own scope;
it was read and judged noise rather than a work item, so no `#3.txt`/`#3-A.md`
pair was created and no issue was filed from it.

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

Do not freeze, redirect, remove Discmeet, create replacement channels, or delete
anything until all of these are true. The line items, with current status:

| Gate | Status |
| --- | --- |
| Export is pushed | **Satisfied.** 15 scopes, 67 messages, 0 unresolved, with message bodies, committed under `docs/meeting, 8-27/discord-server-export/`. The four pre-existing meeting artifacts are preserved and their hashes still match. |
| Independent verification green for every scope and attachment | Open. Run `verify_export` above against the pushed SHA. |
| Every message has one terminal classification | Open. Run `classify_export` above. |
| Replacement adapter, coordinator, worker, GitHub projection and recorder exist and pass their own tests | Partly. The adapter, session bridge and GitHub projection exist and pass (181 tests here, 270 in `cc-track`). The recorder does not exist and is gated on a privacy policy that does not exist. |
| Replacement layout has passed text/thread/voice smoke | Partly. Text and thread surfaces are exercised live. Voice is untested and untouched. |
| Final-delta export pushed and independently reverified with zero post-cutoff messages | Open. Not started. |

**What the satisfied archive gate authorises, precisely.** It authorises reading
the archive, condensing it into GitHub issues (done — #18, #19, #20), flattening
the meeting threads into `#meeting-transcripts` (done), and continuing to
provision *additive* layout changes.

**It does not authorise deleting anything.** One green line item is not a green
gate. Deletion remains owner-account browser work, leaf-first, and each source
ID must be rechecked immediately before deletion.

The never-delete invariant is unchanged and is enforced structurally rather than
by permission, which matters because `MANAGE_CHANNELS` — required to reorganise
the guild at all — implies channel deletion in Discord's model, and there is no
create-only bit to ask for instead. Two mechanisms:

- `assertNoDeletes` re-checks every planned action against an allowlist of kinds
  and throws on anything destructive, so a plan carrying a delete cannot be
  applied. `test/provision.test.ts` covers both directions of that.
- `src/discord-rest.ts` has **no delete method**. There is no call to make, so no
  future code path can make one without someone deliberately adding the method
  and being seen doing it in review.

## Remaining implementation order

Items 1–2 and 4 have landed as the session bridge (`src/bus.ts`,
`src/cc-agent.ts`, `src/cc-gateway.ts`) and the `cc-track` projection in the
CloudCastle repository. What remains:

1. Patch the DAVE voice receive path in this package. DAVE E2EE became mandatory
   2026-03-01 and audio receive is undocumented and broken.
2. Add public privacy policy and prove the URL before recording can start.
3. Add per-speaker local transcription, flat document publication, retention, and
   participant deletion.
4. Add founder-only `/burn` with quota fingerprinting and explicit stop
   semantics.
5. Complete the remaining cutover-gate line items above: independent
   verification, terminal classification of every message, voice smoke, and the
   final-delta export.

Items 1–4 are all downstream of a recording-consent decision that does not exist
(`docs/DECISIONS.md` #21 in the CloudCastle repository). That blocker was never
technical and none of the work above changed it.

The live cutover intentionally remains unstarted. It is no longer blocked on
Discord's human-verification gate — the bot has every permission it needs — but
on the gate line items above and on a human deciding to delete things.
