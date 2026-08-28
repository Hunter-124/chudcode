"""Terminal classification gate for the pre-cutover Discord archive."""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal

MessageClassification = Literal["addressed", "in_progress", "proposed", "superseded", "context_only"]
VALID_CLASSIFICATIONS: frozenset[str] = frozenset(
    {"addressed", "in_progress", "proposed", "superseded", "context_only"}
)

# Every migration-source text channel and known thread in the approved cutover plan.
REQUIRED_SOURCE_IDS: frozenset[str] = frozenset(
    {
        "1542614939540263073",  # milestones
        "1542626782639824916",  # updates
        "1542626296012472360",  # chat
        "1542626326362460200",  # documents
        "1542474554012864574",  # meeting-transcripts
        "1542626072405868664",  # que
        "1542614440602771476",  # problems
        "1542614871772893244",  # priority-task-list
        "1542615109686263899",  # git
        "1542631105608556574",  # sessions
        "1542493184423239750",  # Equity Structure & Funding Strategy
        "1542489253051895889",  # Simplify Admin Console...
        "1542475506270871612",  # Test of Audio Setup
    }
)


@dataclass(frozen=True, slots=True)
class ClassificationRecord:
    classification: MessageClassification
    export_file: str
    line_range: str
    old_message_id: str
    old_channel_id: str
    export_commit_sha: str


@dataclass(frozen=True, slots=True)
class ClassificationReport:
    complete: bool
    message_count: int
    source_ids: tuple[str, ...]
    missing_source_ids: tuple[str, ...]
    output_path: str


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def classify_export(
    *,
    export_dir: Path,
    export_commit_sha: str,
    overrides: Mapping[str, MessageClassification] | None = None,
    output_name: str = "message-classifications.jsonl",
) -> ClassificationReport:
    """Classify each exported message exactly once, defaulting honestly to context_only."""

    export_dir = export_dir.resolve()
    manifest_path = export_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("version") != 1:
        raise ValueError("unsupported archive manifest version")
    if manifest.get("unresolved"):
        raise ValueError("archive has unresolved scopes; classification cannot be terminal")
    if not export_commit_sha or any(char.isspace() for char in export_commit_sha):
        raise ValueError("export_commit_sha must be a non-empty git revision")

    requested = dict(overrides or {})
    invalid = sorted({value for value in requested.values() if value not in VALID_CLASSIFICATIONS})
    if invalid:
        raise ValueError(f"invalid classifications: {', '.join(invalid)}")

    scopes_by_id = {str(scope["id"]): scope for scope in manifest.get("scopes", [])}
    missing = tuple(sorted(REQUIRED_SOURCE_IDS - scopes_by_id.keys()))
    if missing:
        raise ValueError(f"manifest is missing required migration sources: {', '.join(missing)}")

    records: list[ClassificationRecord] = []
    seen_messages: set[str] = set()
    for source_id in sorted(REQUIRED_SOURCE_IDS):
        scope = scopes_by_id[source_id]
        if scope.get("errors"):
            raise ValueError(f"source {source_id} has archive errors")
        relative = scope.get("jsonl_path")
        if not isinstance(relative, str) or not relative:
            if int(scope.get("message_count", 0)) == 0:
                continue
            raise ValueError(f"source {source_id} has messages but no JSONL path")
        jsonl_path = (export_dir / relative).resolve()
        if export_dir not in jsonl_path.parents:
            raise ValueError(f"source {source_id} JSONL escapes export directory")
        for line_number, line in enumerate(jsonl_path.read_text(encoding="utf-8").splitlines(), start=1):
            if not line.strip():
                continue
            message = json.loads(line)
            message_id = str(message["id"])
            channel_id = str(message["channel_id"])
            if channel_id != source_id:
                raise ValueError(f"message {message_id} is stored under the wrong source")
            if message_id in seen_messages:
                raise ValueError(f"message {message_id} is duplicated across export files")
            seen_messages.add(message_id)
            classification = requested.pop(message_id, "context_only")
            records.append(
                ClassificationRecord(
                    classification=classification,
                    export_file=relative,
                    line_range=f"{line_number}-{line_number}",
                    old_message_id=message_id,
                    old_channel_id=channel_id,
                    export_commit_sha=export_commit_sha,
                )
            )

    if requested:
        raise ValueError(f"classification overrides reference unknown messages: {', '.join(sorted(requested))}")

    manifest_ids = {
        str(message_id)
        for source_id in REQUIRED_SOURCE_IDS
        for message_id in scopes_by_id[source_id].get("message_ids", [])
    }
    if seen_messages != manifest_ids:
        missing_messages = sorted(manifest_ids - seen_messages)
        extra_messages = sorted(seen_messages - manifest_ids)
        raise ValueError(f"JSONL/manifest message mismatch: missing={missing_messages}, extra={extra_messages}")

    records.sort(key=lambda record: (int(record.old_channel_id), int(record.old_message_id)))
    output_path = export_dir / output_name
    content = "".join(json.dumps(asdict(record), sort_keys=True, separators=(",", ":")) + "\n" for record in records)
    _atomic_write(output_path, content)
    return ClassificationReport(
        complete=True,
        message_count=len(records),
        source_ids=tuple(sorted(REQUIRED_SOURCE_IDS)),
        missing_source_ids=(),
        output_path=output_name,
    )
