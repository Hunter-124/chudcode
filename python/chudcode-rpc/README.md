# chudcode-rpc

Typed Python bindings for the internal agent runtime's `chudcode --mode rpc` protocol.

This package wraps the newline-delimited JSON RPC transport exposed by the CLI and
provides:

- typed command methods for the stable RPC surface
- typed startup options for common `chudcode --mode rpc` flags such as thinking level,
  tool selection, prompt appends, provider session IDs, and headless session toggles
- typed protocol models for state, bash results, compaction, and session stats
- automatic protocol v2 negotiation, lossless chunk reassembly, and stable message pagination
- a process-backed client that manages request correlation over stdio
- typed per-event listeners plus a typed catch-all notification hook
- helpers for collecting prompt runs and handling extension UI requests in manual or headless mode
- typed host-tool helpers so Python RPC owners can expose custom tools with JSON Schema metadata
- typed, secret-safe provider authentication and project-memory commands for embedding hosts
- typed local speech status/start/stop/cancel wrappers with bounded transcripts

## Basic Usage

```python
from chudcode_rpc import RpcClient

with RpcClient(provider="anthropic", model="claude-sonnet-4-5") as client:
    state = client.get_state()
    print(state.model.id if state.model else "no model")

    turn = client.prompt_and_wait("Reply with just the word hello")
    print(turn.require_assistant_text())
```

The wrapper also exposes the common RPC startup flags directly, so scripts do not
need to build `extra_args` by hand:

```python
from chudcode_rpc import RpcClient

with RpcClient(
    model="openrouter/anthropic/claude-sonnet-4.6",
    thinking="high",
    no_session=True,
    no_skills=True,
    no_rules=True,
    tools=("read", "edit", "write"),
    append_system_prompt="Focus on reproducible benchmark behavior.",
) as client:
    print(client.get_state().thinking_level)
```

For orchestration hosts, the wrapper also exposes typed event hooks and a simple
way to seed todos before the first prompt:

```python
from chudcode_rpc import MessageUpdateEvent, RpcClient


def on_message_update(event: MessageUpdateEvent) -> None:
    assistant_event = event.assistant_message_event
    if assistant_event.get("type") == "text_delta":
        print(assistant_event["delta"], end="", flush=True)


with RpcClient(
    model="openrouter/anthropic/claude-sonnet-4.6", no_session=True
) as client:
    client.on_message_update(on_message_update)
    client.set_todos(
        [
            "Map the read and edit tool surface.",
            "Exercise the supported edit paths.",
            "Write concrete findings and gaps.",
        ]
    )
    client.prompt_and_wait("Evaluate the current tool behavior.")
```

`set_todos()` accepts either a flat list of todo strings/items or explicit
phases, and `get_state().todo_phases` returns the typed current todo state.

By default the client runs:

```bash
chudcode --mode rpc
```

You can also point it at a custom command, which is useful inside this repo while
developing against the Bun entrypoint:

```python
from chudcode_rpc import RpcClient

with RpcClient(
    command=[
        "bun",
        "packages/coding-agent/src/cli.ts",
        "--mode",
        "rpc",
        "--provider",
        "anthropic",
        "--model",
        "claude-sonnet-4-5",
    ],
) as client:
    print(client.get_state().session_id)
```

## Speech-to-Text

The client exposes the four native speech commands without introducing another
audio or ASR implementation:

```python
from chudcode_rpc import RpcClient

with RpcClient(no_session=True, request_timeout=600.0) as client:
    status = client.stt_status()
    if status.available:
        client.stt_start()
        # Keep consuming passive extension UI requests while recording.
        result = client.stt_stop()
        print(result.text)
    else:
        print(status.error or "Speech-to-text is disabled")
```

`stt_status()` returns typed availability, state, selected model, optional model
download progress, and a secret-sanitized error. `stt_start()` allows one
capture per RPC process. `stt_stop()` flushes the warm streaming worker and
returns at most 64 KiB of text. `stt_cancel()` is safe in idle, model setup,
recording, and transcription states and discards accumulated text.

Model progress, listening/transcribing state, partial transcript text, and
errors arrive as passive `ExtensionUiRequest` values (`setStatus`,
`set_editor_text`, and `notify`). They do not require UI responses. Closing the
client closes stdin; the server then stops capture and terminates its ASR worker.

## Provider Authentication and Project Memory

Embedding hosts can inspect and update the same credential store used by
Chudcode without reading token material. Auth results contain only provider
status, credential-kind presence, and sanitized account identities:

```python
import os

from chudcode_rpc import RpcClient

with RpcClient(no_session=True) as client:
    state = client.get_auth_state("anthropic")
    provider = state.providers[0]
    print(provider.authenticated, provider.has_api_key, provider.accounts)

    api_key = os.environ["ANTHROPIC_API_KEY"]
    if client.validate_api_key("anthropic", api_key).valid:
        result = client.set_api_key("anthropic", api_key)
        print(result.provider.authenticated)

    client.remove_api_key("anthropic", account_id="account-1")
    client.logout_provider("anthropic", account_id="account-1")
```

`validate_api_key()` and `set_api_key()` accept keys up to 64 KiB and never
place the key in a result dataclass. If transport or server failure text
contains the submitted key, the client replaces it with `[REDACTED]` before
raising. `login(provider_id)` keeps the existing OAuth flow; handle its
`extension_ui_request` notifications (for example `open_url` or `input`)
before the final typed `LoginResult`.

Project memory uses the configured Chudcode memory backend and scopes each
operation to an explicit project root:

```python
from chudcode_rpc import RpcClient

with RpcClient(no_session=True) as client:
    stored = client.memory_remember(
        "/work/acme",
        "The release branch is main.",
        kind="working",
        source="project settings",
        importance=0.8,
    )
    recalled = client.memory_recall(
        "/work/acme",
        "release branch",
        limit=5,
        token_budget=800,
        kind="working",
    )
    stats = client.memory_stats("/work/acme")

    print(stored.id, recalled.hits[0].content, stats.stats.backend)
```

Recall results are returned as an immutable tuple of typed `MemoryHit` values.
The daemon bounds `limit` to 1–100 hits and `token_budget` to 1–32768 tokens
(default 4096); project roots are limited to 4 KiB, remembered content to
64 KiB, and recall queries to 8 KiB.

## Host-Owned Custom Tools

RPC hosts can expose custom tools to the agent with JSON Schema metadata. The
Python helper keeps the wire format simple while still giving the handler a
typed signature:

```python
from typing import TypedDict

from chudcode_rpc import RpcClient, host_tool


class EchoArgs(TypedDict):
    message: str


def echo_host(args: EchoArgs, context) -> str:
    context.send_update(f"working:{args['message']}")
    return f"host:{args['message']}"


with RpcClient(
    no_session=True,
    custom_tools=(
        host_tool(
            name="echo_host",
            description="Echo a value from the Python host",
            parameters={
                "type": "object",
                "properties": {"message": {"type": "string"}},
                "required": ["message"],
                "additionalProperties": False,
            },
            execute=echo_host,
        ),
    ),
) as client:
    client.prompt_and_wait("Use the echo_host tool with the value hello")
```

If you want runtime conversion into a richer Python type, pass `decode=` to
`host_tool(...)`. That lets you keep the JSON Schema contract on the wire while
parsing the incoming argument object into a dataclass or model in the handler.

## Host-Owned URI Schemes

Hosts can also expose custom URL schemes that behave like virtual files.
Registered schemes are routed through the agent's `read` (and `write`) tools
over the same RPC transport — handlers do the actual I/O on the Python side:

```python
from chudcode_rpc import RpcClient, host_uri

rows: dict[str, str] = {"42": "id=42\nname=Alice\n"}


def read_row(url: str, _ctx) -> str:
    row_id = url.removeprefix("db://users/")
    return rows[row_id]


def write_row(url: str, content: str, _ctx) -> None:
    row_id = url.removeprefix("db://users/")
    rows[row_id] = content


with RpcClient(
    no_session=True,
    host_uris=(
        host_uri(
            scheme="db",
            description="Virtual db row files",
            read=read_row,
            write=write_row,
        ),
    ),
) as client:
    client.prompt_and_wait("Read db://users/42 and rewrite it with name=Bob")
```

Schemes registered as read-only (no `write=`) reject `write` calls with a
clear error. The agent's `edit` tool does not target host URIs — hosts that
want mutation expose `write` and the model uses the `write` tool with the
full replacement content.

## Extension UI Requests

Extensions in RPC mode can ask the host for input. Those requests are available as
typed `ExtensionUiRequest` instances:

```python
request = client.next_ui_request(timeout=5.0)

if request.method == "confirm":
    client.send_ui_confirmation(request.id, True)
elif request.method == "select":
    # option_details aligns positionally with options when descriptions are present.
    for index, label in enumerate(request.options or ()):
        detail = request.option_details[index] if request.option_details else {}
        print(label, detail.get("description"))
    client.send_ui_value(request.id, "approved")
elif request.method in {"input", "editor"}:
    client.send_ui_value(request.id, "approved")
```

For non-interactive scripts, you can install a default headless policy instead of
handling every request manually:

```python
with RpcClient(model="anthropic/claude-sonnet-4-5") as client:
    client.install_headless_ui()
    turn = client.prompt_and_wait("needs ui-safe automation")
    print(turn.assistant_text)
```

That helper ignores passive UI notifications (`notify`, `setStatus`, `setWidget`,
`setTitle`, `set_editor_text`), answers `confirm` with `False`, and cancels
`select`/`input`/`editor` requests unless you provide explicit values.

## Error Handling and Retained History

The client now surfaces more of the transport edge cases that the wire protocol
allows:

- id-less `parse` and unknown-command failures are correlated back to the
  waiting request when they can be matched unambiguously
- late `prompt` / `abort_and_prompt` scheduling failures cause
  `prompt_and_wait()` and `wait_for_idle()` to raise instead of timing out
- unmatched background error responses are exposed through
  `client.protocol_errors` and `client.on_protocol_error(...)`
- listener exceptions no longer kill the stdout reader thread; they are exposed
  through `client.listener_errors` and `client.on_listener_error(...)`

For long-lived hosts, retained event and stderr history is bounded by default:

```python
from chudcode_rpc import RpcClient

with RpcClient(max_event_history=20_000, max_stderr_chunks=256) as client:
    ...
```

If a single prompt streams more events than `max_event_history` allows,
`prompt_and_wait()` raises a clear error so hosts can increase the limit instead
of silently losing earlier events.

Prompt lifecycle collection is intentionally single-flight. Only one of
`prompt_and_wait()`, `wait_for_idle()`, or `collect_events()` may be active at a
time on a client instance. If a host needs concurrent orchestration, use
separate `RpcClient` instances instead of overlapping lifecycle waiters on one
session.

## Text Helpers

`assistant_text()` and `message_text()` now return visible text blocks only.
If a host explicitly needs reasoning text too, use the `*_with_thinking`
helpers:

```python
from chudcode_rpc import assistant_text, assistant_text_with_thinking

visible = assistant_text(message)
full = assistant_text_with_thinking(message)
```

## Protocol Reference

The canonical wire protocol still lives in the repo at
[`docs/rpc.md`](../../docs/rpc.md).
