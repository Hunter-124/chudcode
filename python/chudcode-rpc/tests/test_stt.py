from __future__ import annotations

import unittest

from chudcode_rpc import (
    RpcClient,
    SttCancelResult,
    SttStartResult,
    SttStatus,
    SttStopResult,
)
from chudcode_rpc.protocol import JsonObject, JsonValue


class RecordingClient(RpcClient):
    def __init__(self, responses: dict[str, JsonObject]) -> None:
        super().__init__(command=("unused",))
        self.responses = responses
        self.calls: list[tuple[str, JsonObject]] = []

    def _request(self, command_type: str, **payload: JsonValue) -> JsonObject:
        self.calls.append((command_type, dict(payload)))
        return self.responses[command_type]


class SttClientTests(unittest.TestCase):
    def test_typed_wrappers_use_the_four_canonical_commands(self) -> None:
        client = RecordingClient(
            {
                "stt_status": {
                    "ok": True,
                    "available": True,
                    "state": "idle",
                    "model": "fast",
                    "progress": 42,
                },
                "stt_start": {"ok": True, "state": "recording", "model": "fast"},
                "stt_stop": {"ok": True, "text": "hello world", "state": "idle"},
                "stt_cancel": {"ok": True, "state": "idle"},
            }
        )

        status = client.stt_status()
        started = client.stt_start()
        stopped = client.stt_stop()
        cancelled = client.stt_cancel()

        self.assertEqual(
            status,
            SttStatus(
                ok=True,
                available=True,
                state="idle",
                model="fast",
                progress=42,
            ),
        )
        self.assertEqual(
            started, SttStartResult(ok=True, state="recording", model="fast")
        )
        self.assertEqual(
            stopped, SttStopResult(ok=True, text="hello world", state="idle")
        )
        self.assertEqual(cancelled, SttCancelResult(ok=True, state="idle"))
        self.assertEqual(
            client.calls,
            [
                ("stt_status", {}),
                ("stt_start", {}),
                ("stt_stop", {}),
                ("stt_cancel", {}),
            ],
        )

    def test_status_preserves_unavailable_and_secret_safe_error(self) -> None:
        client = RecordingClient(
            {
                "stt_status": {
                    "ok": True,
                    "available": False,
                    "state": "idle",
                    "model": "fast",
                    "error": "Microphone permission denied",
                }
            }
        )
        status = client.stt_status()
        self.assertFalse(status.available)
        self.assertEqual(status.error, "Microphone permission denied")
        self.assertNotIn("token", repr(status))


if __name__ == "__main__":
    unittest.main()
