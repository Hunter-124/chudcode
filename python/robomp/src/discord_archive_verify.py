"""Independent live verification for a committed Discord migration archive."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Protocol

import httpx

_MESSAGE_CHANNEL_TYPES = frozenset({0, 2, 5, 10, 11, 12, 13})
_ARCHIVE_PARENT_TYPES = frozenset({0, 5, 15, 16})


class DiscordVerificationError(RuntimeError):
    def __init__(self, message: str, *, status: int | None = None, code: int | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


class DiscordREST(Protocol):
    async def get_json(self, path: str, params: Mapping[str, str | int] | None = None) -> Any: ...

    async def get_bytes(self, url: str) -> bytes: ...

    async def close(self) -> None: ...


class CommittedReader(Protocol):
    def is_ancestor_of_origin_main(self, commit_sha: str) -> bool: ...

    def read(self, commit_sha: str, relative_path: str) -> bytes: ...


@dataclass(frozen=True, slots=True)
class AttachmentMismatch:
    message_id: str
    filename: str
    reason: str


@dataclass(frozen=True, slots=True)
class ScopeVerification:
    scope_id: str
    kind: str
    verified: bool
    exported_count: int
    live_count: int
    missing_message_ids: tuple[str, ...] = ()
    extra_message_ids: tuple[str, ...] = ()
    attachment_mismatches: tuple[AttachmentMismatch, ...] = ()
    errors: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class VerificationReport:
    guild_id: str
    commit_sha: str
    commit_ancestor_of_origin_main: bool
    verified: bool
    scopes: tuple[ScopeVerification, ...]
    missing_live_scope_ids: tuple[str, ...] = ()
    extra_live_scope_ids: tuple[str, ...] = ()
    errors: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class HTTPDiscordREST:
    def __init__(self, token: str) -> None:
        if not token or any(char.isspace() for char in token):
            raise ValueError("Discord token file is empty or malformed")
        self._client = httpx.AsyncClient(
            base_url="https://discord.com/api/v10",
            headers={"Authorization": f"Bot {token}", "User-Agent": "CloudCastleArchiveVerifier/1"},
            follow_redirects=False,
            timeout=30,
        )

    @classmethod
    def from_token_file(cls) -> HTTPDiscordREST:
        token_file = os.environ.get("DISCORD_TOKEN_FILE")
        if not token_file:
            raise RuntimeError("DISCORD_TOKEN_FILE must name a root-readable token file")
        path = Path(token_file)
        mode = path.stat().st_mode & 0o777
        if mode & 0o077:
            raise PermissionError(f"Discord token file permissions must be 0600 or stricter, got {mode:04o}")
        return cls(path.read_text(encoding="utf-8").strip())

    async def get_json(self, path: str, params: Mapping[str, str | int] | None = None) -> Any:
        response = await self._client.get(path, params=params)
        if response.status_code >= 400:
            code: int | None = None
            message = response.text[:200]
            try:
                payload = response.json()
                code = payload.get("code")
                message = str(payload.get("message", message))
            except ValueError:
                pass
            raise DiscordVerificationError(message, status=response.status_code, code=code)
        return response.json()

    async def get_bytes(self, url: str) -> bytes:
        if not url.startswith(("https://cdn.discordapp.com/", "https://media.discordapp.net/")):
            raise DiscordVerificationError("refusing non-Discord attachment URL")
        response = await self._client.get(url)
        if response.status_code >= 400:
            raise DiscordVerificationError(
                f"attachment download returned {response.status_code}", status=response.status_code
            )
        return response.content

    async def close(self) -> None:
        await self._client.aclose()


class GitCommittedReader:
    def __init__(self, repo_root: Path) -> None:
        self.repo_root = repo_root

    def is_ancestor_of_origin_main(self, commit_sha: str) -> bool:
        result = subprocess.run(
            ["git", "merge-base", "--is-ancestor", commit_sha, "origin/main"],
            cwd=self.repo_root,
            check=False,
            capture_output=True,
        )
        return result.returncode == 0

    def read(self, commit_sha: str, relative_path: str) -> bytes:
        result = subprocess.run(
            ["git", "show", f"{commit_sha}:{relative_path}"],
            cwd=self.repo_root,
            check=False,
            capture_output=True,
        )
        if result.returncode != 0:
            raise FileNotFoundError(f"{relative_path} is absent from commit {commit_sha}")
        return result.stdout


def _repo_root(export_dir: Path) -> Path:
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=export_dir,
        check=True,
        capture_output=True,
        text=True,
    )
    return Path(result.stdout.strip()).resolve()


_rest_factory: Callable[[], DiscordREST] = HTTPDiscordREST.from_token_file
_reader_factory: Callable[[Path], CommittedReader] = GitCommittedReader


def configure_verifier_dependencies(
    *,
    rest_factory: Callable[[], DiscordREST] | None = None,
    reader_factory: Callable[[Path], CommittedReader] | None = None,
) -> None:
    """Override dependency factories; intended for deterministic tests."""

    global _rest_factory, _reader_factory
    _rest_factory = rest_factory or HTTPDiscordREST.from_token_file
    _reader_factory = reader_factory or GitCommittedReader


def _safe_relative(export_dir: Path, repo_root: Path, relative: str) -> str:
    candidate = (export_dir / relative).resolve()
    if repo_root != candidate and repo_root not in candidate.parents:
        raise ValueError(f"archive path escapes repository: {relative}")
    return candidate.relative_to(repo_root).as_posix()


def _load_committed_json(reader: CommittedReader, commit_sha: str, relative_path: str) -> Any:
    return json.loads(reader.read(commit_sha, relative_path).decode("utf-8"))


async def _paginate_threads(rest: DiscordREST, parent_id: str, flavor: str) -> list[dict[str, Any]]:
    path = f"/channels/{parent_id}/users/@me/threads/archived/private" if flavor == "joined" else f"/channels/{parent_id}/threads/archived/{flavor}"
    threads: list[dict[str, Any]] = []
    before: str | None = None
    seen: set[str] = set()
    while True:
        params: dict[str, str | int] = {"limit": 100}
        if before is not None:
            params["before"] = before
        payload = await rest.get_json(path, params)
        page = list(payload.get("threads", []))
        fresh = [thread for thread in page if str(thread["id"]) not in seen]
        for thread in fresh:
            seen.add(str(thread["id"]))
            threads.append(thread)
        if not payload.get("has_more"):
            break
        if not page or not fresh:
            raise DiscordVerificationError(f"{flavor} archived-thread pagination made no progress")
        last = page[-1]
        before = str(last["id"] if flavor == "joined" else last["thread_metadata"]["archive_timestamp"])
    return threads


async def _enumerate_live_scopes(rest: DiscordREST, guild_id: str) -> dict[str, dict[str, Any]]:
    channels = list(await rest.get_json(f"/guilds/{guild_id}/channels"))
    active_payload = await rest.get_json(f"/guilds/{guild_id}/threads/active")
    scopes: dict[str, dict[str, Any]] = {
        str(channel["id"]): channel for channel in channels if int(channel.get("type", -1)) in _MESSAGE_CHANNEL_TYPES
    }
    for thread in active_payload.get("threads", []):
        scopes[str(thread["id"])] = thread
    for parent in channels:
        parent_type = int(parent.get("type", -1))
        if parent_type not in _ARCHIVE_PARENT_TYPES:
            continue
        parent_id = str(parent["id"])
        flavors = ("public", "private", "joined") if parent_type == 0 else ("public",)
        for flavor in flavors:
            for thread in await _paginate_threads(rest, parent_id, flavor):
                scopes[str(thread["id"])] = thread
    return scopes


async def _paginate_messages(
    rest: DiscordREST, channel_id: str, cutoff: str | None
) -> tuple[list[str], dict[tuple[str, str], dict[str, Any]]]:
    messages: list[dict[str, Any]] = []
    after: str | None = None
    seen: set[str] = set()
    while True:
        params: dict[str, str | int] = {"limit": 100}
        if after is not None:
            params["after"] = after
        page = list(await rest.get_json(f"/channels/{channel_id}/messages", params))
        page.sort(key=lambda message: int(message["id"]))
        fresh = [message for message in page if str(message["id"]) not in seen]
        for message in fresh:
            seen.add(str(message["id"]))
            messages.append(message)
        if len(page) < 100:
            break
        if not fresh:
            raise DiscordVerificationError("message pagination made no progress")
        after = str(fresh[-1]["id"])
    if cutoff is not None:
        messages = [message for message in messages if int(str(message["id"])) < int(cutoff)]
    ids = [str(message["id"]) for message in messages]
    attachments: dict[tuple[str, str], dict[str, Any]] = {}
    for message in messages:
        for attachment in message.get("attachments", []):
            attachments[(str(message["id"]), str(attachment["filename"]))] = attachment
    return ids, attachments


def _committed_scope_ids(
    *,
    reader: CommittedReader,
    commit_sha: str,
    export_dir: Path,
    repo_root: Path,
    scope: Mapping[str, Any],
) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    relative = scope.get("jsonl_path")
    if not relative:
        return [], errors
    repo_relative = _safe_relative(export_dir, repo_root, str(relative))
    try:
        text = reader.read(commit_sha, repo_relative).decode("utf-8")
        ids = [str(json.loads(line)["id"]) for line in text.splitlines() if line.strip()]
    except (FileNotFoundError, UnicodeDecodeError, json.JSONDecodeError, KeyError) as exc:
        return [], [f"committed JSONL unreadable: {exc}"]
    manifest_ids = [str(value) for value in scope.get("message_ids", [])]
    if ids != manifest_ids:
        errors.append("committed JSONL message IDs differ from manifest ordering")
    return ids, errors


async def _verify_attachments(
    *,
    rest: DiscordREST,
    reader: CommittedReader,
    commit_sha: str,
    export_dir: Path,
    repo_root: Path,
    scope: Mapping[str, Any],
    live: Mapping[tuple[str, str], Mapping[str, Any]],
) -> list[AttachmentMismatch]:
    mismatches: list[AttachmentMismatch] = []
    for exported in scope.get("attachments", []):
        message_id = str(exported["message_id"])
        filename = str(exported["filename"])
        live_attachment = live.get((message_id, filename))
        if live_attachment is None:
            mismatches.append(AttachmentMismatch(message_id, filename, "attachment absent from live message"))
            continue
        try:
            committed = reader.read(
                commit_sha,
                _safe_relative(export_dir, repo_root, str(exported["relative_path"])),
            )
        except (FileNotFoundError, ValueError) as exc:
            mismatches.append(AttachmentMismatch(message_id, filename, f"committed attachment unreadable: {exc}"))
            continue
        committed_digest = hashlib.sha256(committed).hexdigest()
        if len(committed) != int(exported["size"]) or committed_digest != str(exported["sha256"]):
            mismatches.append(AttachmentMismatch(message_id, filename, "committed bytes differ from manifest"))
            continue
        try:
            downloaded = await rest.get_bytes(str(live_attachment["url"]))
        except DiscordVerificationError as exc:
            mismatches.append(AttachmentMismatch(message_id, filename, f"live download failed: {exc}"))
            continue
        if len(downloaded) != len(committed) or hashlib.sha256(downloaded).hexdigest() != committed_digest:
            mismatches.append(AttachmentMismatch(message_id, filename, "live bytes differ from committed bytes"))
    return mismatches


async def verify_export(
    *,
    guild_id: str,
    export_dir: Path,
    commit_sha: str,
    cutoff_by_channel: Mapping[str, str] | None,
) -> VerificationReport:
    """Compare live Discord state with every blob in a pushed archive commit."""

    export_dir = export_dir.resolve()
    repo_root = _repo_root(export_dir)
    reader = _reader_factory(repo_root)
    ancestor = reader.is_ancestor_of_origin_main(commit_sha)
    errors: list[str] = []
    try:
        manifest_relative = export_dir.relative_to(repo_root).joinpath("manifest.json").as_posix()
        manifest = _load_committed_json(reader, commit_sha, manifest_relative)
    except (ValueError, FileNotFoundError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        return VerificationReport(guild_id, commit_sha, ancestor, False, (), errors=(f"manifest unreadable: {exc}",))
    if manifest.get("version") != 1:
        errors.append("unsupported manifest version")
    if str(manifest.get("guild_id")) != guild_id:
        errors.append("manifest guild does not match requested guild")
    if manifest.get("unresolved"):
        errors.append("manifest contains unresolved scopes")
    for entry in manifest.get("files", []):
        try:
            blob = reader.read(commit_sha, _safe_relative(export_dir, repo_root, str(entry["path"])))
            if len(blob) != int(entry["size"]) or hashlib.sha256(blob).hexdigest() != str(entry["sha256"]):
                errors.append(f"committed file digest mismatch: {entry['path']}")
        except (FileNotFoundError, ValueError, KeyError) as exc:
            errors.append(f"committed file unreadable: {exc}")

    rest = _rest_factory()
    try:
        live_scopes = await _enumerate_live_scopes(rest, guild_id)
        exported_scopes = {
            str(scope["id"]): scope
            for scope in manifest.get("scopes", [])
            if int(scope.get("type", 10 if scope.get("kind") == "thread" else 0)) in _MESSAGE_CHANNEL_TYPES
        }
        exported_ids = set(exported_scopes)
        live_ids = set(live_scopes)
        missing_live = tuple(sorted(exported_ids - live_ids, key=int))
        extra_live = tuple(sorted(live_ids - exported_ids, key=int))
        scope_reports: list[ScopeVerification] = []
        for scope_id in sorted(exported_ids, key=int):
            scope = exported_scopes[scope_id]
            scope_errors = [str(value) for value in scope.get("errors", [])]
            committed_ids, committed_errors = _committed_scope_ids(
                reader=reader,
                commit_sha=commit_sha,
                export_dir=export_dir,
                repo_root=repo_root,
                scope=scope,
            )
            scope_errors.extend(committed_errors)
            live_message_ids: list[str] = []
            live_attachments: dict[tuple[str, str], dict[str, Any]] = {}
            if scope_id not in live_scopes:
                scope_errors.append("scope is absent from live Discord")
            else:
                try:
                    live_message_ids, live_attachments = await _paginate_messages(
                        rest, scope_id, (cutoff_by_channel or {}).get(scope_id)
                    )
                except DiscordVerificationError as exc:
                    qualifier = f"status={exc.status} code={exc.code}" if exc.status or exc.code else "REST error"
                    scope_errors.append(f"live scope unreadable ({qualifier}): {exc}")
            exported_set = set(committed_ids)
            live_set = set(live_message_ids)
            missing_messages = tuple(sorted(live_set - exported_set, key=int))
            extra_messages = tuple(sorted(exported_set - live_set, key=int))
            attachment_mismatches = await _verify_attachments(
                rest=rest,
                reader=reader,
                commit_sha=commit_sha,
                export_dir=export_dir,
                repo_root=repo_root,
                scope=scope,
                live=live_attachments,
            )
            verified = not scope_errors and not missing_messages and not extra_messages and not attachment_mismatches
            scope_reports.append(
                ScopeVerification(
                    scope_id=scope_id,
                    kind=str(scope.get("kind", "channel")),
                    verified=verified,
                    exported_count=len(committed_ids),
                    live_count=len(live_message_ids),
                    missing_message_ids=missing_messages,
                    extra_message_ids=extra_messages,
                    attachment_mismatches=tuple(attachment_mismatches),
                    errors=tuple(scope_errors),
                )
            )
    except DiscordVerificationError as exc:
        errors.append(f"scope enumeration failed: {exc}")
        scope_reports = []
        missing_live = ()
        extra_live = ()
    finally:
        await rest.close()

    verified = (
        ancestor
        and not errors
        and not missing_live
        and not extra_live
        and bool(scope_reports)
        and all(scope.verified for scope in scope_reports)
    )
    return VerificationReport(
        guild_id=guild_id,
        commit_sha=commit_sha,
        commit_ancestor_of_origin_main=ancestor,
        verified=verified,
        scopes=tuple(scope_reports),
        missing_live_scope_ids=missing_live,
        extra_live_scope_ids=extra_live,
        errors=tuple(errors),
    )
