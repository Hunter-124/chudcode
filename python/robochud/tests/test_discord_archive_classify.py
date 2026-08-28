from __future__ import annotations

import json
from pathlib import Path

import pytest

from robochud.discord_archive_classify import REQUIRED_SOURCE_IDS, classify_export


def _write_export(root: Path, *, missing: str | None = None, unresolved: bool = False) -> None:
    scopes = []
    for index, source_id in enumerate(sorted(REQUIRED_SOURCE_IDS)):
        if source_id == missing:
            continue
        relative = f"source-{source_id}.jsonl"
        message_id = str(2_000_000_000_000_000_000 + index)
        (root / relative).write_text(
            json.dumps({"id": message_id, "channel_id": source_id, "content": "context"}) + "\n",
            encoding="utf-8",
        )
        scopes.append(
            {
                "id": source_id,
                "kind": "thread" if source_id in {"1542493184423239750", "1542489253051895889", "1542475506270871612"} else "channel",
                "jsonl_path": relative,
                "message_count": 1,
                "message_ids": [message_id],
                "errors": [],
            }
        )
    (root / "manifest.json").write_text(
        json.dumps({"version": 1, "scopes": scopes, "unresolved": ["blocked"] if unresolved else []}),
        encoding="utf-8",
    )


def test_classify_export_defaults_to_context_only_and_preserves_provenance(tmp_path: Path) -> None:
    _write_export(tmp_path)

    report = classify_export(export_dir=tmp_path, export_commit_sha="abc123")

    records = [json.loads(line) for line in (tmp_path / report.output_path).read_text(encoding="utf-8").splitlines()]
    assert report.complete
    assert report.message_count == len(REQUIRED_SOURCE_IDS)
    assert {record["classification"] for record in records} == {"context_only"}
    assert {record["export_commit_sha"] for record in records} == {"abc123"}
    assert all(record["line_range"] == "1-1" for record in records)


def test_classify_export_applies_known_override(tmp_path: Path) -> None:
    _write_export(tmp_path)
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    message_id = manifest["scopes"][0]["message_ids"][0]

    classify_export(export_dir=tmp_path, export_commit_sha="abc123", overrides={message_id: "proposed"})

    records = [json.loads(line) for line in (tmp_path / "message-classifications.jsonl").read_text().splitlines()]
    assert next(record for record in records if record["old_message_id"] == message_id)["classification"] == "proposed"


def test_classify_export_rejects_missing_source(tmp_path: Path) -> None:
    missing = next(iter(REQUIRED_SOURCE_IDS))
    _write_export(tmp_path, missing=missing)

    with pytest.raises(ValueError, match="missing required migration sources"):
        classify_export(export_dir=tmp_path, export_commit_sha="abc123")


def test_classify_export_rejects_unresolved_archive(tmp_path: Path) -> None:
    _write_export(tmp_path, unresolved=True)

    with pytest.raises(ValueError, match="unresolved scopes"):
        classify_export(export_dir=tmp_path, export_commit_sha="abc123")


def test_classify_export_rejects_unknown_override(tmp_path: Path) -> None:
    _write_export(tmp_path)

    with pytest.raises(ValueError, match="unknown messages"):
        classify_export(export_dir=tmp_path, export_commit_sha="abc123", overrides={"999": "addressed"})
