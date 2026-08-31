from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

from chudcode_rpc import RpcClient, RpcCommandError
from chudcode_rpc.protocol import JsonObject, JsonValue

PROVIDER = {
    "providerId": "anthropic",
    "name": "Anthropic",
    "authenticated": True,
    "hasApiKey": True,
    "hasOAuth": False,
    "origin": "api_key",
    "accounts": [
        {
            "accountId": "account-1",
            "email": "dev@example.com",
            "projectId": "project-1",
            "orgId": "org-1",
            "orgName": "Example Org",
        }
    ],
}


class RecordingClient(RpcClient):
    def __init__(self, responses: dict[str, JsonObject]) -> None:
        super().__init__(command=("unused",))
        self.responses = responses
        self.calls: list[tuple[str, JsonObject]] = []

    def _request(self, command_type: str, **payload: JsonValue) -> JsonObject:
        serialized = {key: value for key, value in payload.items() if value is not None}
        self.calls.append((command_type, serialized))
        return self.responses[command_type]


class FailingApiKeyClient(RpcClient):
    def __init__(self) -> None:
        super().__init__(command=("unused",))

    def _request(self, command_type: str, **payload: JsonValue) -> JsonObject:
        key = str(payload["apiKey"])
        raise RpcCommandError(
            command_type,
            f"provider rejected API key {key}",
            code="invalid_api_key",
        )


class AuthMemoryClientTests(unittest.TestCase):
    def test_only_chudcode_rpc_import_package_exists(self) -> None:
        self.assertIsNone(importlib.util.find_spec("omp_rpc"))
        self.assertIsNotNone(importlib.util.find_spec("chudcode_rpc"))

    def test_wrappers_use_canonical_commands_and_payloads(self) -> None:
        client = RecordingClient(
            {
                "get_auth_state": {"providers": [PROVIDER]},
                "validate_api_key": {"providerId": "anthropic", "valid": True},
                "set_api_key": {"provider": PROVIDER},
                "remove_api_key": {
                    "providerId": "anthropic",
                    "removed": True,
                    "provider": PROVIDER,
                },
                "logout_provider": {
                    "providerId": "anthropic",
                    "loggedOut": True,
                    "provider": PROVIDER,
                },
                "login": {"providerId": "anthropic"},
                "memory_remember": {"id": "memory-1"},
                "memory_recall": {
                    "hits": [
                        {
                            "id": "memory-1",
                            "content": "Use the stable RPC seam.",
                            "source": "integration",
                            "timestamp": "2026-08-31T12:00:00Z",
                            "score": 0.95,
                        }
                    ]
                },
                "memory_stats": {
                    "stats": {
                        "backend": "mnemo",
                        "active": True,
                        "writable": True,
                        "searchable": True,
                        "scope": "project",
                        "workingCount": 3,
                        "episodicCount": 2,
                        "tripleCount": 1,
                    }
                },
            }
        )
        secret = "sk-test-secret-value"

        auth = client.get_auth_state("anthropic")
        validation = client.validate_api_key("anthropic", secret)
        set_result = client.set_api_key("anthropic", secret)
        removed = client.remove_api_key("anthropic", "account-1")
        logged_out = client.logout_provider("anthropic")
        login = client.login("anthropic")
        remembered = client.memory_remember(
            Path("/work/project"),
            "Use the stable RPC seam.",
            kind="working",
            source="integration",
            importance=0.9,
        )
        recalled = client.memory_recall(
            "/work/project",
            "stable seam",
            limit=5,
            token_budget=800,
            kind="working",
        )
        stats = client.memory_stats("/work/project")

        self.assertEqual(auth.providers[0].accounts[0].org_name, "Example Org")
        self.assertTrue(validation.valid)
        self.assertEqual(set_result.provider.origin, "api_key")
        self.assertTrue(removed.removed)
        self.assertTrue(logged_out.logged_out)
        self.assertEqual(login.provider_id, "anthropic")
        self.assertEqual(remembered.id, "memory-1")
        self.assertEqual(recalled.hits[0].score, 0.95)
        self.assertEqual(stats.stats.working_count, 3)
        self.assertNotIn(secret, repr(set_result))

        self.assertEqual(
            client.calls,
            [
                ("get_auth_state", {"providerId": "anthropic"}),
                (
                    "validate_api_key",
                    {"providerId": "anthropic", "apiKey": secret},
                ),
                ("set_api_key", {"providerId": "anthropic", "apiKey": secret}),
                (
                    "remove_api_key",
                    {"providerId": "anthropic", "accountId": "account-1"},
                ),
                ("logout_provider", {"providerId": "anthropic"}),
                ("login", {"providerId": "anthropic"}),
                (
                    "memory_remember",
                    {
                        "root": "/work/project",
                        "content": "Use the stable RPC seam.",
                        "kind": "working",
                        "source": "integration",
                        "importance": 0.9,
                    },
                ),
                (
                    "memory_recall",
                    {
                        "root": "/work/project",
                        "query": "stable seam",
                        "limit": 5,
                        "tokenBudget": 800,
                        "kind": "working",
                    },
                ),
                ("memory_stats", {"root": "/work/project"}),
            ],
        )

    def test_api_keys_are_redacted_from_errors_and_repr(self) -> None:
        client = FailingApiKeyClient()
        secret = "sk-private-key-that-must-not-leak"

        for call in (client.validate_api_key, client.set_api_key):
            with self.subTest(call=call.__name__):
                with self.assertRaises(RpcCommandError) as raised:
                    call("anthropic", secret)
                error = raised.exception
                self.assertNotIn(secret, str(error))
                self.assertNotIn(secret, repr(error))
                self.assertNotIn(secret, error.error)
                self.assertIsNone(error.__context__)
                self.assertIn("[REDACTED]", str(error))


if __name__ == "__main__":
    unittest.main()
