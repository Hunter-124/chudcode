from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

import robomp.discord_archive_verify as verify_module
from robomp.discord_archive_verify import DiscordVerificationError, configure_verifier_dependencies, verify_export


class FakeReader:
    def __init__(self, blobs: dict[str, bytes], *, ancestor: bool = True) -> None:
        self.blobs = blobs
        self.ancestor = ancestor

    def is_ancestor_of_origin_main(self, commit_sha: str) -> bool:
        return self.ancestor

    def read(self, commit_sha: str, relative_path: str) -> bytes:
        try:
            return self.blobs[relative_path]
        except KeyError as exc:
            raise FileNotFoundError(relative_path) from exc


class FakeREST:
    def __init__(
        self,
        *,
        messages: list[dict[str, Any]],
        attachment_bytes: bytes = b"attachment",
        private_error: bool = False,
    ) -> None:
        self.messages = messages
        self.attachment_bytes = attachment_bytes
        self.private_error = private_error
        self.closed = False

    async def get_json(self, path: str, params: dict[str, str | int] | None = None) -> Any:
        if path == "/guilds/guild/channels":
            return [{"id": "100", "name": "chat", "type": 0}]
        if path == "/guilds/guild/threads/active":
            return {"threads": []}
        if path == "/channels/100/threads/archived/public":
            return {"threads": [], "has_more": False}
        if path == "/channels/100/threads/archived/private":
            if self.private_error:
                raise DiscordVerificationError("Missing Access", status=403, code=50001)
            return {"threads": [], "has_more": False}
        if path == "/channels/100/users/@me/threads/archived/private":
            return {"threads": [], "has_more": False}
        if path == "/channels/100/messages":
            return self.messages
        raise AssertionError(f"unexpected REST path: {path}")

    async def get_bytes(self, url: str) -> bytes:
        return self.attachment_bytes

    async def close(self) -> None:
        self.closed = True


def _message(message_id: str, *, attachment: bool = False) -> dict[str, Any]:
    value: dict[str, Any] = {"id": message_id, "channel_id": "100", "attachments": []}
    if attachment:
        value["attachments"] = [
            {"filename": "evidence.bin", "url": "https://cdn.discordapp.com/attachments/evidence.bin"}
        ]
    return value


def _fixture(
    root: Path,
    *,
    exported_ids: list[str],
    attachment: bytes | None = None,
    unresolved: bool = False,
) -> tuple[Path, dict[str, bytes]]:
    export_dir = root / "export"
    export_dir.mkdir()
    jsonl = b"".join(
        json.dumps({"id": message_id, "channel_id": "100"}, sort_keys=True).encode() + b"\n"
        for message_id in exported_ids
    )
    attachments = []
    blobs = {"export/chat-100.jsonl": jsonl}
    if attachment is not None:
        relative = "attachments/100/10-evidence.bin"
        blobs[f"export/{relative}"] = attachment
        attachments.append(
            {
                "channel_id": "100",
                "message_id": "10",
                "filename": "evidence.bin",
                "relative_path": relative,
                "size": len(attachment),
                "sha256": hashlib.sha256(attachment).hexdigest(),
                "source_url": "https://cdn.discordapp.com/attachments/evidence.bin",
            }
        )
    manifest = {
        "version": 1,
        "guild_id": "guild",
        "unresolved": ["blocked"] if unresolved else [],
        "files": [],
        "scopes": [
            {
                "id": "100",
                "kind": "channel",
                "type": 0,
                "jsonl_path": "chat-100.jsonl",
                "message_ids": exported_ids,
                "attachments": attachments,
                "errors": [],
            }
        ],
    }
    blobs["export/manifest.json"] = json.dumps(manifest).encode()
    return export_dir, blobs


@pytest.fixture(autouse=True)
def _reset_dependencies() -> None:
    yield
    configure_verifier_dependencies()


@pytest.mark.asyncio
async def test_verify_export_exact_match(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    export_dir, blobs = _fixture(tmp_path, exported_ids=["10"])
    rest = FakeREST(messages=[_message("10")])
    monkeypatch.setattr(verify_module, "_repo_root", lambda _: tmp_path)
    configure_verifier_dependencies(rest_factory=lambda: rest, reader_factory=lambda _: FakeReader(blobs))

    report = await verify_export(guild_id="guild", export_dir=export_dir, commit_sha="abc", cutoff_by_channel=None)

    assert report.verified
    assert report.scopes[0].verified
    assert rest.closed


@pytest.mark.asyncio
async def test_verify_export_reports_missing_exported_message(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    export_dir, blobs = _fixture(tmp_path, exported_ids=["10"])
    monkeypatch.setattr(verify_module, "_repo_root", lambda _: tmp_path)
    configure_verifier_dependencies(
        rest_factory=lambda: FakeREST(messages=[_message("10"), _message("20")]),
        reader_factory=lambda _: FakeReader(blobs),
    )

    report = await verify_export(guild_id="guild", export_dir=export_dir, commit_sha="abc", cutoff_by_channel=None)

    assert not report.verified
    assert report.scopes[0].missing_message_ids == ("20",)


@pytest.mark.asyncio
async def test_verify_export_reports_attachment_hash_mismatch(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    export_dir, blobs = _fixture(tmp_path, exported_ids=["10"], attachment=b"committed")
    monkeypatch.setattr(verify_module, "_repo_root", lambda _: tmp_path)
    configure_verifier_dependencies(
        rest_factory=lambda: FakeREST(messages=[_message("10", attachment=True)], attachment_bytes=b"changed"),
        reader_factory=lambda _: FakeReader(blobs),
    )

    report = await verify_export(guild_id="guild", export_dir=export_dir, commit_sha="abc", cutoff_by_channel=None)

    assert not report.verified
    assert report.scopes[0].attachment_mismatches[0].reason == "live bytes differ from committed bytes"


@pytest.mark.asyncio
async def test_verify_export_fails_unreadable_private_threads(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    export_dir, blobs = _fixture(tmp_path, exported_ids=["10"])
    monkeypatch.setattr(verify_module, "_repo_root", lambda _: tmp_path)
    configure_verifier_dependencies(
        rest_factory=lambda: FakeREST(messages=[_message("10")], private_error=True),
        reader_factory=lambda _: FakeReader(blobs),
    )

    report = await verify_export(guild_id="guild", export_dir=export_dir, commit_sha="abc", cutoff_by_channel=None)

    assert not report.verified
    assert "scope enumeration failed" in report.errors[0]


@pytest.mark.asyncio
async def test_verify_export_applies_exclusive_cutoff(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    export_dir, blobs = _fixture(tmp_path, exported_ids=["10"])
    monkeypatch.setattr(verify_module, "_repo_root", lambda _: tmp_path)
    configure_verifier_dependencies(
        rest_factory=lambda: FakeREST(messages=[_message("10"), _message("20")]),
        reader_factory=lambda _: FakeReader(blobs),
    )

    report = await verify_export(
        guild_id="guild", export_dir=export_dir, commit_sha="abc", cutoff_by_channel={"100": "20"}
    )

    assert report.verified
