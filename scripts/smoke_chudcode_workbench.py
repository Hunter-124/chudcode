#!/usr/bin/env python3
"""Qualify a separate workbench candidate without provider calls or user state.

Usage: python3 scripts/smoke_chudcode_workbench.py --bundle /absolute/candidate
This is evidence for a candidate, not stable-release or performance qualification.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
sys.path.insert(
    0, str(Path(__file__).resolve().parents[1] / "packages/chudcode-workbench/test")
)
from package_chudcode_workbench import digest
from qualification import (
    JsonProcess,
    SmokeError,
    candidate_binary,
    check_candidate,
    install_cleanup_signals,
    isolated_environment,
    positive_timeout,
    run_process,
)


class DesktopSocket:
    """Minimal bounded RFC6455 client for the real local service handshake."""

    def __init__(self, ready: dict, timeout: float):
        self.socket = None
        http = urlsplit(ready.get("url", ""))
        ws = urlsplit(ready.get("wsUrl", ""))
        token = ready.get("token")
        if (
            ready.get("type") != "ready"
            or ready.get("protocol") != 1
            or http.scheme != "http"
            or ws.scheme != "ws"
            or http.hostname != "127.0.0.1"
            or ws.hostname != "127.0.0.1"
            or not http.port
            or ws.port != http.port
            or http.netloc != ws.netloc
            or http.path not in ("", "/")
            or ws.path != "/ws"
            or http.query
            or ws.query
            or http.fragment
            or ws.fragment
            or http.username
            or ws.username
            or not isinstance(token, str)
            or not token
            or len(token) > 4096
            or any(ord(character) < 33 or ord(character) > 126 for character in token)
        ):
            raise SmokeError("Service returned incompatible or unsafe readiness")
        connection = socket.create_connection(("127.0.0.1", http.port), timeout=timeout)
        self.socket = connection
        self.stream = connection.makefile("rb")
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET /ws HTTP/1.1\r\nHost: {ws.netloc}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\nOrigin: {ready['url']}\r\n"
            f"Authorization: Bearer {token}\r\n\r\n"
        )
        try:
            connection.sendall(request.encode("ascii"))
            status = self.stream.readline(4097)
            if not status.startswith(b"HTTP/1.1 101 "):
                raise SmokeError("Real service refused authenticated websocket upgrade")
            headers = {}
            size = len(status)
            while True:
                line = self.stream.readline(4097)
                size += len(line)
                if not line or size > 16384 or not line.endswith(b"\r\n"):
                    raise SmokeError("Invalid websocket upgrade headers")
                if line == b"\r\n":
                    break
                name, separator, value = line.decode("ascii").partition(":")
                if not separator:
                    raise SmokeError("Malformed websocket upgrade header")
                headers[name.lower()] = value.strip()
            expected = base64.b64encode(
                hashlib.sha1(
                    (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")
                ).digest()
            ).decode("ascii")
            if (
                headers.get("sec-websocket-accept") != expected
                or headers.get("upgrade", "").lower() != "websocket"
                or "upgrade" not in headers.get("connection", "").lower().split(", ")
            ):
                raise SmokeError("Invalid websocket upgrade response")
        except BaseException:
            self.close()
            raise

    def _read(self, count: int) -> bytes:
        output = self.stream.read(count)
        if len(output) != count:
            raise SmokeError("Service websocket closed prematurely")
        return output

    def _send(self, opcode: int, payload: bytes) -> None:
        mask = os.urandom(4)
        length = len(payload)
        if length < 126:
            header = bytes((0x80 | opcode, 0x80 | length))
        elif length <= 65535:
            header = bytes((0x80 | opcode, 0x80 | 126)) + struct.pack("!H", length)
        elif length <= 1024 * 1024:
            header = bytes((0x80 | opcode, 0x80 | 127)) + struct.pack("!Q", length)
        else:
            raise SmokeError("Excessive outgoing websocket frame")
        self.socket.sendall(
            header
            + mask
            + bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        )

    def send_request(self, request_id: int, method: str, params: dict) -> None:
        self._send(
            1,
            json.dumps(
                {"t": "request", "id": request_id, "method": method, "params": params}
            ).encode("utf-8"),
        )

    def receive(self, timeout: float) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise SmokeError("Timed out waiting for desktop websocket frame")
            self.socket.settimeout(remaining)
            first, second = self._read(2)
            opcode = first & 0x0F
            if first & 0x70 or not first & 0x80 or second & 0x80:
                raise SmokeError("Unsupported or invalid websocket frame")
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read(8))[0]
            if length > 1024 * 1024 or (opcode >= 8 and length > 125):
                raise SmokeError("Excessive websocket frame")
            payload = self._read(length)
            if opcode == 9:
                self._send(10, payload)
                continue
            if opcode == 10:
                continue
            if opcode != 1:
                raise SmokeError("Service sent non-text websocket data or closed")
            frame = json.loads(payload.decode("utf-8", errors="strict"))
            if not isinstance(frame, dict):
                raise SmokeError("Desktop websocket frame is not an object")
            return frame

    def hello(self, timeout: float) -> dict:
        self.send_request(1, "runtime.hello", {"protocol": 1})
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise SmokeError("Timed out waiting for desktop protocol handshake")
            frame = self.receive(remaining)
            if frame.get("t") == "response" and frame.get("id") == 1:
                result = frame.get("result")
                if (
                    frame.get("method") != "runtime.hello"
                    or frame.get("error")
                    or not isinstance(result, dict)
                    or result.get("protocol") != 1
                    or result.get("product") != "Chudcode"
                ):
                    raise SmokeError("Desktop protocol handshake failed")
                return result

    def close(self) -> None:
        if self.socket is not None:
            self.stream.close()
            self.socket.close()
            self.socket = None


def smoke_service(
    check: dict, root: Path, environment: dict[str, str], timeout: float
) -> dict:
    service = Path(check["service"])
    version = run_process([str(service), "--version"], root, environment, timeout)
    if version != check["version"]:
        raise SmokeError("Compiled service version does not match candidate")
    workspace = root / "workspace"
    workspace.mkdir()
    started = time.perf_counter()
    process = JsonProcess(
        [str(service), "--workspace", str(workspace)], root, environment, timeout
    )
    try:
        # Readiness must be the first stdout object; no logging on the private pipe.
        ready = process.receive(lambda _: True)
        ready_ms = (time.perf_counter() - started) * 1000
        client = DesktopSocket(ready, timeout)
        try:
            requested = time.perf_counter()
            client.hello(timeout)
            hello_ms = (time.perf_counter() - requested) * 1000
        finally:
            client.close()
    except BaseException:
        process.close()
        raise
    process.close(require_success=True, single_stdout_frame=True)
    return {
        "protocol": 1,
        "ready_ms": ready_ms,
        "hello_request_ms": hello_ms,
        "stdin_eof_exit": 0,
    }


def smoke_rpc(
    check: dict, root: Path, environment: dict[str, str], timeout: float
) -> dict:
    version = run_process([check["chud"], "--version"], root, environment, timeout)
    if version != f"Chudcode v{check['version']}":
        raise SmokeError("Retained chud executable version does not match candidate")
    command = [
        check["chud"],
        "--mode",
        "rpc",
        "--no-session",
        "--no-tools",
        "--no-lsp",
        "--no-mcp",
        "--no-skills",
        "--no-rules",
        "--no-extensions",
        "--no-title",
        "--no-ui",
    ]
    started = time.perf_counter()
    process = JsonProcess(command, root, environment, timeout)
    latencies = {}
    try:
        ready = process.receive(lambda _: True)
        ready_ms = (time.perf_counter() - started) * 1000
        if (
            ready.get("type") != "ready"
            or ready.get("protocolVersion") != 1
            or 2 not in ready.get("supportedProtocolVersions", [])
        ):
            raise SmokeError("Retained chud executable does not advertise RPC v2")
        if (
            ready.get("maxFrameBytes") != 1024 * 1024
            or ready.get("maxReassembledFrameBytes") != 64 * 1024 * 1024
        ):
            raise SmokeError("Retained RPC transport limits are incompatible")

        def request(command: str, **fields) -> dict:
            requested = time.perf_counter()
            process.send({"id": command, "type": command, **fields})

            def matches(frame: dict) -> bool:
                # This no-provider smoke makes only small requests. Never silently
                # discard chunks, fatal events, or an incompatible ready frame.
                if frame.get("type") in ("rpc_chunk", "ready", "extension_error"):
                    raise SmokeError(
                        f"Unexpected RPC frame during {command}: {frame.get('type')}"
                    )
                return frame.get("type") == "response" and frame.get("id") == command

            response = process.receive(matches)
            latencies[command] = (time.perf_counter() - requested) * 1000
            if (
                response.get("success") is not True
                or response.get("command") != command
                or not isinstance(response.get("data"), dict)
            ):
                raise SmokeError(
                    f"Retained RPC command failed or returned incompatible data: {command}"
                )
            return response["data"]

        if request("negotiate_protocol", protocolVersion=2).get("protocolVersion") != 2:
            raise SmokeError("Retained chud executable rejected RPC v2 negotiation")
        state = request("get_state")
        if (
            state.get("isStreaming") is not False
            or state.get("messageCount") != 0
            or not isinstance(state.get("sessionId"), str)
        ):
            raise SmokeError(
                "Isolated retained RPC session is not idle, empty, and identified"
            )
        if not isinstance(request("get_available_commands").get("commands"), list):
            raise SmokeError("Retained RPC command discovery failed")
        request("set_host_tools", tools=[])
        request("set_subagent_subscription", level="events")
        if not isinstance(request("get_messages").get("messages"), list):
            raise SmokeError("Retained RPC message retrieval failed")
    except BaseException:
        process.close()
        raise
    process.close(require_success=True)
    return {
        "protocol": 2,
        "ready_ms": ready_ms,
        "request_ms": latencies,
        "stdin_eof_exit": 0,
    }


def main() -> int:
    install_cleanup_signals()
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--binary", type=Path, help="Absolute or relative Rust candidate launcher"
    )
    source.add_argument("--bundle", type=Path, help="Assembled candidate directory")
    parser.add_argument(
        "--timeout",
        type=positive_timeout,
        default=60.0,
        help="Per-operation safety timeout in seconds, not a performance budget",
    )
    arguments = parser.parse_args()
    try:
        binary = candidate_binary(arguments.binary, arguments.bundle)
        with tempfile.TemporaryDirectory(
            prefix="chudcode-workbench-smoke-"
        ) as directory:
            root = Path(directory).resolve()
            environment = isolated_environment(root)
            check = check_candidate(binary, root, environment, arguments.timeout)
            service = smoke_service(check, root, environment, arguments.timeout)
            rpc = smoke_rpc(check, root, environment, arguments.timeout)
            print(
                json.dumps(
                    {
                        "qualification": "candidate-smoke-only",
                        "stable_ready": False,
                        "version": check["version"],
                        "target": check.get("target"),
                        "launcher_sha256": digest(binary),
                        "launcher_check": "passed",
                        "service": service,
                        "retained_rpc": rpc,
                        "provider_turns": 0,
                        "timing_policy": "observations only; no performance threshold",
                        "unqualified_gates": [
                            "actual editor UI",
                            "CAD downstream smoke",
                            "macOS/Windows execution and signing",
                            "live provider/OAuth",
                            "CloudCastle deployed integration",
                        ],
                    },
                    sort_keys=True,
                )
            )
        return 0
    except (
        SmokeError,
        OSError,
        ValueError,
        subprocess.SubprocessError,
        KeyboardInterrupt,
    ) as error:
        print(
            f"Candidate smoke FAILED: {type(error).__name__}: {error}", file=sys.stderr
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
