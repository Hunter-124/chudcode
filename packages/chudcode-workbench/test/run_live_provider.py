#!/usr/bin/env python3
"""Explicit real Ollama + workspace-tool gate against both candidate transports.

No endpoint/model defaults: this probe never runs as part of no-provider smoke.
Only compact evidence is printed; private logs/transcripts are deleted on exit.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import time
from http.client import HTTPException
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))
from package_chudcode_workbench import digest
from qualification import (
    JsonProcess,
    SmokeError,
    candidate_binary,
    check_candidate,
    install_cleanup_signals,
    isolated_environment,
    positive_timeout,
)
from smoke_chudcode_workbench import DesktopSocket


class GateError(SmokeError):
    """A fixed diagnostic code, never provider content or credentials."""

    def __init__(self, code: str, diagnostic: dict | None = None):
        super().__init__(code)
        self.diagnostic = diagnostic


def safe_tool_metadata(event: dict) -> dict:
    def identifier(value: object) -> str:
        if isinstance(value, str) and re.fullmatch(
            r"[A-Za-z_][A-Za-z0-9_.-]{0,63}", value
        ):
            return value
        return "[invalid_identifier]"

    args = event.get("args")
    keys = sorted(identifier(key) for key in args) if isinstance(args, dict) else []
    return {
        "tool_name": identifier(event.get("toolName")),
        "argument_keys": keys[:16],
        "argument_keys_truncated": len(keys) > 16,
        "arguments_are_object": isinstance(args, dict),
        "call_id_is_string": isinstance(event.get("toolCallId"), str),
    }


class Deadline:
    def __init__(self, timeout: float):
        self.end = time.monotonic() + timeout

    def remaining(self) -> float:
        remaining = self.end - time.monotonic()
        if remaining <= 0:
            raise GateError("timeout")
        return remaining


def provider_metadata(base_url: str, model: str, deadline: Deadline) -> dict:
    url = urlsplit(base_url)
    if (
        url.scheme not in ("http", "https")
        or not url.hostname
        or url.username is not None
        or url.password is not None
        or url.path not in ("", "/")
        or url.query
        or url.fragment
        or not model
        or len(model) > 256
        or any(ord(character) < 33 or ord(character) > 126 for character in model)
    ):
        raise GateError("unsupported_endpoint_or_model")
    # Bypass ambient proxies and their credentials. Endpoint support is verified
    # using Ollama's real metadata API, not a synthetic completion or echo.
    opener = build_opener(ProxyHandler({}))
    request = Request(
        base_url.rstrip("/") + "/api/show",
        data=json.dumps({"model": model}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with opener.open(request, timeout=min(30, deadline.remaining())) as response:
        raw = response.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise GateError("excessive_provider_metadata")
    metadata = json.loads(raw)
    if not isinstance(metadata, dict) or "tools" not in metadata.get(
        "capabilities", []
    ):
        raise GateError("model_does_not_support_tools")
    info = metadata.get("model_info", {})
    context_lengths = [
        value
        for key, value in info.items()
        if key.endswith(".context_length") and isinstance(value, int) and value > 0
    ]
    if not context_lengths or min(context_lengths) < 32768:
        raise GateError("unsupported_model_context_window")
    # A model's explicit num_ctx overrides the daemon's context default. Its
    # architectural maximum does not prove enough context is actually enabled.
    parameters = metadata.get("parameters", "")
    configured_context = (
        re.search(r"(?m)^\s*num_ctx\s+(-?\d+)\s*$", parameters)
        if isinstance(parameters, str)
        else None
    )
    if configured_context and int(configured_context.group(1)) < 32768:
        raise GateError("configured_model_context_too_small")
    return {
        "context_window": min(32768, min(context_lengths)),
        "supports_tools": True,
        "reasoning": "thinking" in metadata.get("capabilities", []),
    }


def prepare(
    root: Path, base_url: str, model: str, metadata: dict
) -> tuple[dict, Path, bytes]:
    environment = isolated_environment(root)
    agent = root / "agent"
    agent.mkdir(mode=0o700)
    environment["PI_CODING_AGENT_DIR"] = str(agent)
    environment["OLLAMA_BASE_URL"] = base_url.rstrip("/")
    # JSON is a YAML subset; no third-party parser or secret-bearing config.
    (agent / "models.yml").write_text(
        json.dumps(
            {
                "providers": {
                    "ollama": {
                        "api": "ollama-chat",
                        "baseUrl": base_url.rstrip("/"),
                        "auth": "none",
                        "models": [
                            {
                                "id": model,
                                "reasoning": metadata["reasoning"],
                                "input": ["text"],
                                "supportsTools": True,
                                "contextWindow": metadata["context_window"],
                                "maxTokens": 2048,
                            }
                        ],
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    # Disable every other bundled provider, including keyless catalog discovery.
    # enabledProviders governs foreign config discovery, not model network access.
    catalog = Path(__file__).resolve().parents[2] / "catalog/src/compat/rules.json"
    provider_ids = set(json.loads(catalog.read_text(encoding="utf-8"))["providers"])
    provider_ids.update(("local", "web", "llama.cpp", "lm-studio", "apple"))
    provider_ids.discard("ollama")
    (agent / "config.yml").write_text(
        json.dumps(
            {
                "enabledProviders": ["ollama"],
                "enabledModels": [f"ollama/{model}"],
                "modelRoles": {"default": f"ollama/{model}"},
                "defaultThinkingLevel": "off",
                "temperature": 0,
                "retry": {"enabled": False, "modelFallback": False},
                "tools": {
                    "approvalMode": "write",
                    "approval": {"eval": "allow"},
                    "maxTimeout": 30,
                },
                "disabledProviders": sorted(provider_ids),
                "vision": {"autoDownload": False},
                "startup": {"checkUpdate": False},
            }
        ),
        encoding="utf-8",
    )
    workspace = root / "workspace"
    workspace.mkdir(mode=0o700)
    challenge = {
        "nonce": secrets.token_hex(16),
        "a": secrets.randbelow(90) + 10,
        "b": secrets.randbelow(90) + 10,
    }
    (workspace / "challenge.json").write_text(
        json.dumps(challenge) + "\n", encoding="utf-8"
    )
    expected = f"NONCE={challenge['nonce'].upper()}\nSUM={challenge['a'] + challenge['b']}\n".encode(
        "ascii"
    )
    return environment, workspace, expected


class ToolTurn:
    def __init__(self, workspace: Path, model: str):
        self.workspace = workspace
        self.model = model
        self.calls: dict[str, tuple[str, dict]] = {}
        self.generated_calls: dict[str, tuple[str, int]] = {}
        self.successes: dict[str, tuple[str, int]] = {}
        self.successful_tools: set[str] = set()
        self.tool_calls = 0
        self.challenge_bytes = (workspace / "challenge.json").read_bytes()
        self.assistant_messages = 0
        self.output_tokens = 0
        self.finished = False
        self.ended = False
        self.frames = 0

    def observe(self, event: dict) -> None:
        self.frames += 1
        if self.frames > 50000:
            raise GateError("excessive_provider_events")
        kind = event.get("type")
        if kind in ("extension_error", "auto_retry_start", "rpc_chunk"):
            raise GateError("model_or_transport_error")
        if kind == "notice" and event.get("level") == "error":
            raise GateError("model_or_tool_error")
        if kind == "message_end":
            message = event.get("message", {})
            if message.get("role") == "assistant":
                if message.get("stopReason") not in ("stop", "toolUse") or message.get(
                    "errorMessage"
                ):
                    reason = message.get("stopReason")
                    raise GateError(
                        "provider_completion_error",
                        {
                            "stop_reason": reason
                            if reason
                            in ("stop", "length", "toolUse", "error", "aborted")
                            else "unexpected",
                            "provider_error_present": bool(message.get("errorMessage")),
                            "completed_messages": self.assistant_messages,
                        },
                    )
                if message.get("model") != self.model:
                    raise GateError("unexpected_provider_model")
                if "provider" in message and message["provider"] != "ollama":
                    raise GateError("unexpected_provider")
                content = message.get("content", [])
                for block in content:
                    if block.get("type") == "toolCall":
                        call_id, name = block.get("id"), block.get("name")
                        if not isinstance(call_id, str) or not isinstance(name, str):
                            raise GateError("invalid_provider_tool_call")
                        previous_name, count = self.generated_calls.get(
                            call_id, (name, 0)
                        )
                        if previous_name != name:
                            raise GateError("provider_tool_id_mismatch")
                        self.generated_calls[call_id] = (name, count + 1)
                self.assistant_messages += 1
                if self.assistant_messages > 8:
                    raise GateError("excessive_model_turns")
                self.output_tokens += message.get("usage", {}).get("output", 0)
                text = "".join(
                    block.get("text", "")
                    for block in content
                    if block.get("type") == "text"
                )
                if message.get("stopReason") == "stop" and text.strip():
                    self.finished = True
        if kind == "tool_execution_start":
            name, call_id, args = (
                event.get("toolName"),
                event.get("toolCallId"),
                event.get("args"),
            )
            diagnostic = safe_tool_metadata(event)
            if (
                name not in ("read", "write", "edit", "eval", "todo")
                or not isinstance(args, dict)
                or not isinstance(call_id, str)
            ):
                raise GateError("unexpected_tool_execution", diagnostic)
            if call_id in self.calls:
                raise GateError("duplicate_active_tool_id", diagnostic)
            self.calls[call_id] = (name, args)
            self.tool_calls += 1
            if self.tool_calls > 6:
                raise GateError("excessive_tool_calls", diagnostic)
        if kind == "tool_execution_end":
            call_id = event.get("toolCallId")
            known_call = self.calls.get(call_id) if isinstance(call_id, str) else None
            diagnostic = safe_tool_metadata(
                {
                    "toolName": event.get("toolName"),
                    "toolCallId": call_id,
                    "args": known_call[1] if known_call else None,
                }
            )
            diagnostic["reported_tool_error"] = event.get("isError") is True
            if event.get("isError") is not False or known_call is None:
                raise GateError("tool_execution_error", diagnostic)
            if self.calls[call_id][0] != event.get("toolName"):
                raise GateError("tool_execution_mismatch", diagnostic)
            name = known_call[0]
            previous_name, count = self.successes.get(call_id, (name, 0))
            if previous_name != name:
                raise GateError("runtime_tool_id_mismatch", diagnostic)
            self.successes[call_id] = (name, count + 1)
            self.successful_tools.add(name)
            del self.calls[call_id]
        if kind == "agent_end":
            self.ended = True

    def evidence(self, expected: bytes) -> dict:
        names = self.successful_tools
        if not (
            self.ended
            and self.finished
            and self.assistant_messages >= 2
            and self.output_tokens > 0
            and names.intersection(("read", "write", "edit", "eval"))
            and not self.calls
            and self.tool_calls > 0
            and self.successes == self.generated_calls
        ):
            raise GateError("missing_provider_completion_or_tool_effects")
        challenge = self.workspace / "challenge.json"
        if (
            challenge.is_symlink()
            or not challenge.is_file()
            or challenge.stat().st_size != len(self.challenge_bytes)
            or challenge.read_bytes() != self.challenge_bytes
        ):
            raise GateError("input_fixture_changed")
        result = self.workspace / "result.txt"
        if (
            result.is_symlink()
            or not result.is_file()
            or result.stat().st_size != len(expected)
        ):
            raise GateError("missing_or_invalid_result_file")
        if result.read_bytes() != expected:
            raise GateError("computed_result_mismatch")
        return {
            "assistant_messages": self.assistant_messages,
            "output_tokens": self.output_tokens,
            "successful_tools": sorted(names),
            "tool_calls": self.tool_calls,
            "input_unchanged": True,
            "result_bytes": len(expected),
            "result_sha256": hashlib.sha256(expected).hexdigest(),
        }


def desktop_turn(
    check: dict,
    root: Path,
    environment: dict,
    workspace: Path,
    expected: bytes,
    model: str,
    prompt: str,
    deadline: Deadline,
) -> dict:
    process = JsonProcess(
        [check["service"], "--workspace", str(workspace)],
        workspace,
        environment,
        deadline.remaining(),
    )
    client = None
    success = False
    started = time.monotonic()
    gate = ToolTurn(workspace, model)
    try:
        ready = process.receive(lambda _: True)
        client = DesktopSocket(ready, deadline.remaining())
        client.send_request(1, "runtime.hello", {"protocol": 1})
        welcome = None
        hello = None
        while welcome is None or hello is None:
            frame = client.receive(deadline.remaining())
            if frame.get("t") == "error":
                raise GateError("desktop_service_error")
            if frame.get("t") == "welcome":
                welcome = frame
            if frame.get("t") == "response" and frame.get("id") == 1:
                if frame.get("error") or frame.get("result") != {
                    "protocol": 1,
                    "product": "Chudcode",
                }:
                    raise GateError("desktop_protocol_error")
                hello = frame
        selected = welcome.get("state", {}).get("model", {})
        if selected.get("id") != model or selected.get("provider") != "ollama":
            raise GateError("desktop_selected_wrong_model")
        session_path = welcome.get("sessionPath")
        if not isinstance(session_path, str) or not Path(
            session_path
        ).resolve().is_relative_to(root):
            raise GateError("desktop_session_outside_isolation")
        client.send_request(
            2, "prompt.send", {"sessionPath": session_path, "text": prompt}
        )
        accepted = False
        while not (accepted and gate.ended):
            frame = client.receive(deadline.remaining())
            if frame.get("t") in ("error", "ui-request"):
                raise GateError("desktop_model_or_tool_error")
            if frame.get("t") == "response" and frame.get("id") == 2:
                if (
                    frame.get("error")
                    or frame.get("result", {}).get("accepted") is not True
                ):
                    raise GateError("desktop_prompt_rejected")
                accepted = True
            if (
                frame.get("t") == "agent-event"
                and frame.get("sessionPath") == session_path
            ):
                gate.observe(frame.get("event", {}))
        evidence = gate.evidence(expected)
        success = True
        return {
            "protocol": 1,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
            **evidence,
        }
    finally:
        try:
            if client is not None:
                client.close()
        finally:
            process.timeout = min(15, max(0.1, deadline.end - time.monotonic()))
            process.close(require_success=success, single_stdout_frame=success)


def rpc_turn(
    check: dict,
    environment: dict,
    workspace: Path,
    expected: bytes,
    model: str,
    prompt: str,
    deadline: Deadline,
) -> dict:
    command = [
        check["chud"],
        "--mode",
        "rpc",
        "--no-session",
        "--provider",
        "ollama",
        "--model",
        model,
        "--thinking",
        "off",
        "--tools",
        "read,write,edit,eval,todo",
        "--no-lsp",
        "--no-mcp",
        "--no-skills",
        "--no-rules",
        "--no-extensions",
        "--no-title",
        "--no-ui",
    ]
    process = JsonProcess(command, workspace, environment, deadline.remaining())
    gate = ToolTurn(workspace, model)
    started = time.monotonic()
    success = False

    def receive() -> dict:
        process.timeout = deadline.remaining()
        return process.receive(lambda _: True)

    def request(command: str, **fields) -> dict:
        process.send({"id": command, "type": command, **fields})
        while True:
            frame = receive()
            gate.observe(frame)
            if frame.get("type") == "response" and frame.get("id") == command:
                if frame.get("success") is not True or frame.get("command") != command:
                    raise GateError("rpc_command_error")
                return frame.get("data", {})

    try:
        ready = receive()
        if ready.get("type") != "ready" or 2 not in ready.get(
            "supportedProtocolVersions", []
        ):
            raise GateError("rpc_protocol_error")
        if request("negotiate_protocol", protocolVersion=2).get("protocolVersion") != 2:
            raise GateError("rpc_negotiation_error")
        state = request("get_state")
        if state.get("isStreaming") is not False or state.get("messageCount") != 0:
            raise GateError("rpc_not_isolated_idle")
        selected = state.get("model", {})
        if selected.get("id") != model or selected.get("provider") != "ollama":
            raise GateError("rpc_selected_wrong_model")
        request("prompt", message=prompt)
        while True:
            frame = receive()
            gate.observe(frame)
            if frame.get("type") == "prompt_result" and frame.get("id") == "prompt":
                if (
                    frame.get("status") != "completed"
                    or frame.get("agentInvoked") is not True
                    or frame.get("sessionSettled") is not True
                ):
                    raise GateError("rpc_provider_completion_error")
                break
        evidence = gate.evidence(expected)
        success = True
        return {
            "protocol": 2,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
            **evidence,
        }
    finally:
        process.timeout = min(15, max(0.1, deadline.end - time.monotonic()))
        process.close(require_success=success)


def main() -> int:
    install_cleanup_signals()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument(
        "--base-url",
        required=True,
        help="Explicit Ollama HTTP(S) origin, without credentials",
    )
    parser.add_argument(
        "--model", required=True, help="Exact installed Ollama model ID; no fallback"
    )
    parser.add_argument(
        "--timeout",
        type=positive_timeout,
        default=600,
        help="Total gate deadline in seconds (default: 600)",
    )
    args = parser.parse_args()
    stage = "prerequisites"
    evidence = {"schema": 1, "gate": "chudcode-live-provider", "success": False}
    try:
        deadline = Deadline(args.timeout)
        metadata = provider_metadata(args.base_url, args.model, deadline)
        evidence["provider"] = "ollama"
        evidence["model"] = args.model
        evidence["probe_sha256"] = digest(Path(__file__))
        evidence["prompt_sha256"] = digest(
            Path(__file__).with_name("live-provider-prompt.md")
        )
        prompt = (
            Path(__file__)
            .with_name("live-provider-prompt.md")
            .read_text(encoding="utf-8")
        )
        with tempfile.TemporaryDirectory(prefix="chudcode-live-provider-") as temporary:
            root = Path(temporary).resolve()
            desktop_root = root / "desktop"
            desktop_root.mkdir()
            environment, workspace, expected = prepare(
                desktop_root, args.base_url, args.model, metadata
            )
            check = check_candidate(
                candidate_binary(None, args.bundle),
                desktop_root,
                environment,
                min(15, deadline.remaining() / 2),
            )
            evidence["version"] = check["version"]
            bundle_root = Path(check["root"])
            evidence["manifest_sha256"] = digest(
                bundle_root / "candidate-manifest.json"
            )
            evidence["binaries"] = {
                name: {
                    "path": Path(check[name]).relative_to(bundle_root).as_posix(),
                    "sha256": digest(Path(check[name])),
                }
                for name in ("service", "chud")
            }
            stage = "desktop"
            evidence["desktop"] = desktop_turn(
                check,
                desktop_root,
                environment,
                workspace,
                expected,
                args.model,
                prompt,
                deadline,
            )
            stage = "rpc"
            rpc_root = root / "rpc"
            rpc_root.mkdir()
            environment, workspace, expected = prepare(
                rpc_root, args.base_url, args.model, metadata
            )
            evidence["rpc"] = rpc_turn(
                check, environment, workspace, expected, args.model, prompt, deadline
            )
        evidence["success"] = True
        print(json.dumps(evidence, separators=(",", ":"), sort_keys=True))
        return 0
    except (
        SmokeError,
        OSError,
        HTTPException,
        ValueError,
        TypeError,
        KeyError,
        subprocess.SubprocessError,
        KeyboardInterrupt,
    ) as error:
        # Never print arbitrary exception text: HTTP errors, candidate logs, and
        # model/tool errors can contain URLs, credentials, or transcript content.
        code = str(error) if isinstance(error, GateError) else "qualification_error"
        if isinstance(error, (TimeoutError, socket.timeout, subprocess.TimeoutExpired)):
            code = "timeout"
        if isinstance(error, KeyboardInterrupt):
            code = "interrupted"
        evidence.update(
            {"stage": stage, "error": code, "error_type": type(error).__name__}
        )
        if isinstance(error, GateError) and error.diagnostic is not None:
            evidence["diagnostic"] = error.diagnostic
        print(json.dumps(evidence, separators=(",", ":"), sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
