# hub

> The single agent-coordination surface: direct peer messaging, durable topic and blackboard coordination, background-job control, and supervision of shared long-running processes.

Merged from the former `irc`, `job`, and `launch` tools; each existing op family keeps its old behavior and rendering. Durable coordination extends that wire contract without changing DM, broadcast, wait, inbox, reply, or wake semantics.

## Source
- Entry: `packages/coding-agent/src/tools/hub/index.ts` (schema, `HubTool`, unified `wait`, renderer dispatch)
- Messaging half: `packages/coding-agent/src/tools/hub/messaging.ts`
- Jobs half: `packages/coding-agent/src/tools/hub/jobs.ts`
- Launch half: `packages/coding-agent/src/tools/hub/launch.ts`
- Shared types: `packages/coding-agent/src/tools/hub/types.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/hub.md`
- Key collaborators:
  - `packages/coding-agent/src/irc/bus.ts` — process-global `IrcBus`: per-agent mailboxes, delivery, waiter matching, and live delivery to topic subscribers.
  - `packages/coding-agent/src/registry/agent-registry.ts` — process-global agent directory and status.
  - `packages/coding-agent/src/registry/agent-lifecycle.ts` — revival of parked recipients on direct send.
  - `packages/coding-agent/src/session/agent-session.ts` — `deliverIrcMessage(...)`: recipient-side injection and wake turns.
  - `packages/coding-agent/src/async/job-manager.ts` — job registry, cancellation, delivery suppression, smart poll ladder.
  - `packages/coding-agent/src/launch/client.ts` / `broker.ts` / `presence.ts` / `protocol.ts` — process-supervision broker.
  - `packages/coding-agent/src/config/settings-schema.ts` — `irc.timeoutMs`, `async.pollWaitDuration`, `launch.enabled`.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `op` | `"send" \| "wait" \| "inbox" \| "list" \| "subscribe" \| "publish" \| "read" \| "blackboard_get" \| "blackboard_set" \| "jobs" \| "cancel" \| "start" \| "ps" \| "logs" \| "stop" \| "restart" \| "describe"` | Yes | Operation. Existing operation names and shapes are unchanged. |
| `to` | `string` | `send` (peer) | Recipient agent id, or `"all"` for broadcast. Mutually exclusive with `name`. |
| `message` | `string` | `send` / `publish` | Plain-prose DM or topic publication. Empty-after-trim is rejected; topic publication bodies are stored and delivered unchanged. |
| `replyTo` | `string` | No | `send`: message id being answered. |
| `await` | `boolean` | No | Peer `send`: after delivery, block until the next message from that peer arrives. Invalid with `to: "all"`. |
| `from` | `string` | No | `wait`: only accept a message from this agent id (pure message wait). |
| `ids` | `string[]` | No | `wait`: job ids to watch (omit = all running jobs); `cancel`: job ids to kill (required). |
| `timeoutMs` | `number` | No | Peer `send` with `await`, and message/job `wait`: milliseconds; `0` waits indefinitely. Defaults to `irc.timeoutMs` for a reply/pure-message wait and to the poll window when jobs are watched. |
| `peek` | `boolean` | No | `inbox`: leave messages in the process-global bus mailbox. Note that messages already buffered on the live recipient session are still drained into this result by the current implementation. |
| `topic` | `string` | topic ops | Durable topic name, 1-64 characters: ASCII letter/digit first, then letters, digits, `.`, `_`, `:`, `/`, or `-`. |
| `afterRevision` | non-negative integer | No | `read`: return retained topic messages with a higher revision, oldest first for cursor-based paging. Without it, reads return the latest retained messages. |
| `limit` | positive number | No | `list`: peer row limit; `read`: retained message limit (default 50, maximum 100). |
| `key` | `string` | blackboard ops | Shared blackboard key, 1-128 characters, using the topic-name character set. |
| `value` | JSON value | `blackboard_set` | Structured blackboard value. Structured coordination state belongs here, not in peer/topic message envelopes. |
| `expectedRevision` | non-negative integer | No | `blackboard_set`: compare-and-set guard. `0` succeeds only when the key is absent; omitted means unconditional update. |
| `name` | `string` | process ops | Stable project-scoped launch name (1-48 chars). On `send`/`wait` it routes the op to the process broker. |
| `application`, `args`, `env`, `cwd`, `pty`, `ready`, `restart`, `persist`, `detached` | — | `start` | Launch spec, unchanged from the former `launch` tool. |
| `lines`, `head`, `grep`, `follow`, `cursor` | — | `logs` | Log window controls, unchanged. |
| `for`, `pattern` | — | `wait` (name) | Process lifecycle condition / output regex. |
| `text`, `enter`, `keys`, `signal` | — | `send` (name) | Process stdin / terminal keys / signal. |
| `timeout` | `number` | No | `logs`/`stop`/`wait`-with-`name`: seconds; default 30 (stop: 5). |

## Op families and dispatch
- **Direct messaging** — `send` (with `to`), `inbox`, `list`, and `wait` with `from`. Fire-and-forget sends return delivery receipts (`injected`/`woken`/`revived`/`failed`); direct sends can revive parked agents, while broadcasts target visible live peers without reviving every parked agent. `await: true` waits for one reply after delivery. A busy recipient with async execution disabled may auto-reply rather than strand an awaiting sender.
- **Durable topics** — `subscribe`, `publish`, and `read`, keyed by `topic`. Subscriptions and publications are stored in the root session's artifact directory by atomic replace. A publication is committed before it is delivered through the existing `IrcBus` to every currently running/idle subscriber except the publisher; parked subscribers are not stampede-revived. `read` is non-consuming and survives process/session restart.
- **Blackboard** — `blackboard_get` and `blackboard_set`, keyed by `key`. Values are JSON and carry per-key monotonically increasing revisions. `expectedRevision` provides atomic in-process compare-and-set; stale writes fail and return the current entry in `details.blackboard`.
- **Jobs** — `wait` (bare or with `ids`), `cancel`, `jobs`. Owner-scoped visibility, watch/unwatch delivery suppression, `acknowledgeDeliveries` on returned completions, 500 ms `onUpdate` snapshots while waiting, and the `async.pollWaitDuration` fixed/smart wait window. `jobs` is the former job-list snapshot plus the roster of running subagents with no running job entry.
- **Processes** — `start`, `ps`, `logs`, `stop`, `restart`, `describe`, plus `send`/`wait` when they carry `name`. Exact behavior of the former `launch` tool; `ps` is the broker's `list`. See the launch sections below.

`send` with both `to` and `name` is rejected as ambiguous. `wait` routes by target: `name` → process wait; otherwise the unified coordination wait. Topic and blackboard ops require a session transcript because their scope is the root session, not the current process.

## The unified `wait`
One blocking primitive. It resolves job legs (explicit `ids`, owner-scoped and silently filtered, or every running job the caller owns) and — when the session can message peers — parks a bus waiter, then races:
- every watched running job's `job.promise`,
- the first matching incoming message (`from`-filtered when given),
- the wait window — explicit `timeoutMs` if passed (`0` = no window), else `manager.nextPollWaitMs(...)` under `smart` or the fixed `async.pollWaitDuration`,
- the tool-call abort signal.

Outcomes:
- A message wins (even a photo-finish: a message consumed by the bus waiter is never dropped) → the message is returned exactly like the former `irc wait` (`details.waited`), and the jobs keep running; their results still self-deliver.
- A job settles or the window elapses → a job snapshot exactly like the former `job` poll (`details.jobs`, `## Completed` / `## Still Running` sections). An all-running snapshot is flagged `useless` and rendered as a displaceable waiting frame that the next `hub` call supersedes.
- No job legs: pure message wait with peer liveness (bounded by `irc.timeoutMs`); with no running peers either, it returns `No running background jobs to wait for.` immediately (plus the jobless running-agent roster when one exists).
- Explicit `ids` that match nothing visible → `No matching jobs found for IDs: ...` with per-id agent hints (`history://<id>`), never a hang.
- A message already buffered on the session satisfies the wait before anything is watched.

Smart-ladder bookkeeping (`recordPollWaitEnd`) runs only when the smart window was actually used (no explicit `timeoutMs`).

## Outputs
- Direct messaging and job results keep the existing `CoordinationDetails` wire fields and text formats.
- Topic results add `{ topic, topicMessages?, subscribers?, receipts? }`; each retained publication is `{ id, topic, revision, from, body, ts }`.
- Blackboard results add `blackboard`, either `null` or `{ key, value, revision, updatedAt, updatedBy }`. A stale compare-and-set is `isError: true` and includes the current entry.
- Process results remain `LaunchToolDetails` — `{ op, daemon?, daemons?, cursor?, timedOut?, state?, terminalRows?, matched?, spec? }`.
- Streaming remains unchanged: job-watching waits emit `onUpdate` every 500 ms; everything else is single-shot.

## Availability
- The tool is always registered (`loadMode: "essential"`).
- Messaging and durable coordination require an `AgentRegistry` and caller agent id. Durable operations additionally require a `.jsonl` session transcript; their atomic state file is `<root-session-artifact-dir>/hub-state.json`.
- Job ops require `session.asyncJobManager`; otherwise `Async execution is disabled; no background jobs are available.`
- Process ops require `launch.enabled`; otherwise `Process supervision is disabled (launch.enabled=false).`

## Approval
`hubApproval` (per-call): `start`, `stop`, `restart`, and `send`-to-process are `exec`; direct messaging, durable topics/blackboard, job control, `ps`/`logs`/`describe`/`wait` are `read`.

## Starting and readiness (processes)
`application` and `args` are separate fields, so callers do not need shell quoting:

```json
{
  "op": "start",
  "name": "web",
  "application": "bun",
  "args": ["run", "dev"],
  "ready": { "log": "Local:.*http", "port": 5173, "timeout": 30 }
}
```

Defaults: `cwd` = session directory, `args: []`, `env: {}`, `pty: true`, `restart: "no"`, `persist: false`, `detached: false`, readiness timeout 30 s. `detached: true` implies `persist`, forces `pty: false`, and disables stdin. `ready.log` is a regex over captured output; `ready.port` probes TCP at `ready.host` (default `127.0.0.1`); when both are present, both must pass. A readiness timeout leaves the process running and reports its state.

Names are stable and unique within one project directory. A live name must be stopped or restarted; starting a completed name creates a new launch and rotates its prior output log.

## Logs, input, signals (processes)
```json
{"op":"logs","name":"web","grep":"error|warn","lines":50}
{"op":"logs","name":"web","follow":true,"cursor":1842,"timeout":30}
{"op":"send","name":"debugger","text":"breakpoint set --name main"}
{"op":"send","name":"debugger","keys":["CTRL_C"]}
```
Each logs result returns a byte cursor; `follow: true` waits until output advances beyond it, the process exits, or the timeout elapses. The broker keeps a 25 MiB current log plus one rotated log. Keys: `ENTER`, `TAB`, `ESCAPE`, `CTRL_C`, `CTRL_D`, arrows. Signals: `SIGINT`, `SIGTERM`, `SIGHUP`, `SIGQUIT`, `SIGKILL`. Input is one shared stream across all project clients.

## Cross-instance lifecycle (processes)
Unchanged from the former `launch` tool: the first process op starts a detached broker over a private socket under `~/.chudcode/run/daemons/<project-hash>/`; every Chudcode instance in the project shares names, logs, and state. After the last Chudcode process exits, the broker stops non-persistent processes and exits. `persist: true` opts out of last-client teardown; restart policies (`no`/`on-failure`/`always`) use bounded exponential backoff up to 30 s.

## Limits & Caps
- Direct mailboxes: 100 messages per agent (`MAILBOX_CAP`); oldest dropped beyond the cap.
- Durable topics: 64 topics, 100 subscribers per topic, 100 retained publications per topic, and 500 retained publications across the session. Oldest publications are removed first. Publication bodies are limited to 16 KiB UTF-8.
- Topic reads: default 50 messages, maximum 100.
- Blackboard: 128 keys, 32 KiB of JSON per value. New keys are rejected at the cap; existing keys remain updatable.
- `irc.timeoutMs` default `120_000`; `0` disables; negative/non-finite fall back to the default.
- Poll window: `async.pollWaitDuration` — `5s`/`10s`/`30s`/`1m`/`5m`/`smart` (default); smart ladder `[5s..5m]` climbing per back-to-back wait, resetting after 60 s without waiting.
- Job retention 5 min; manager max-running fallback 15; `async.maxJobs` clamped 1..100.
- Launch names 1-48 chars; `ready.port` 1..65535; `logs`/`wait`/`stop` timeouts capped at one hour.

## Errors
- Existing validation and delivery behavior is unchanged for direct messaging, jobs, and processes.
- Topic operations reject missing/invalid topic names, missing/empty publications, oversized bodies, missing session persistence, and retention-cap exhaustion.
- Blackboard operations reject invalid keys, absent/non-JSON/oversized values, missing session persistence, entry-cap exhaustion, invalid expected revisions, and stale compare-and-set revisions.
- A `wait` timeout and an empty topic `read` are normal results, never errors.
- Per-recipient delivery failures surface as `failed` receipts; a topic publication remains successful once durably committed even when no subscriber is currently live.

## Notes
- Existing DMs, broadcasts, replies, waits, inbox drains, and idle/parked wake behavior are unchanged. Their bodies remain plain prose and their wire shapes do not gain structured envelopes.
- Topic publication bodies also remain plain prose. Topic metadata is returned in tool result details and persisted separately.
- The durable state is root-session scoped, moves with the session artifact directory, and is written through a private temporary file followed by rename. Per-file operations are serialized so topic revisions and blackboard compare-and-set are deterministic within the agent process.
- A running topic subscriber receives the publication through the same recipient-side `deliverIrcMessage(...)` path as a DM. Idle subscribers wake normally; parked subscribers retain their subscription and can read history after revival but are not revived by a publication.
- Messaging a parked agent directly still revives it — the only resume primitive; the task tool has no `resume` parameter.
- TUI rendering remains family-compatible; durable coordination uses the messaging renderer's generic Hub result frame.
