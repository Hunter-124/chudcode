from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from robomp.secret_file_guard import (
    SecretFilePermissionError,
    _offending_trustees,
    _windows_owner_sid_and_sddl,
    assert_secret_file_private,
    restrict_command_hint,
)

OWNER = "S-1-5-21-1111111111-2222222222-3333333333-1001"

windows_only = pytest.mark.skipif(os.name != "nt", reason="NTFS ACL behaviour is Windows-specific")
posix_only = pytest.mark.skipif(os.name == "nt", reason="POSIX mode bits are not meaningful on Windows")


def _token(tmp_path: Path) -> Path:
    path = tmp_path / "discord-token"
    path.write_text("token-value", encoding="utf-8")
    return path


# --- SDDL parsing (platform independent) ------------------------------------


def test_owner_system_and_administrators_are_not_offenders() -> None:
    sddl = f"O:BAG:S-1-5-32-544D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;{OWNER})(A;ID;FA;;;OW)"
    assert _offending_trustees(sddl, OWNER) == []


def test_everyone_and_builtin_users_are_offenders() -> None:
    sddl = f"O:BAG:BAD:AI(A;ID;FA;;;{OWNER})(A;ID;FR;;;WD)(A;ID;FR;;;BU)"
    assert _offending_trustees(sddl, OWNER) == ["WD", "BU"]


def test_authenticated_users_is_an_offender() -> None:
    assert _offending_trustees(f"O:BAG:BAD:(A;;FR;;;AU)(A;;FA;;;{OWNER})", OWNER) == ["AU"]


def test_a_second_users_sid_is_an_offender() -> None:
    other = "S-1-5-21-1111111111-2222222222-3333333333-1002"
    assert _offending_trustees(f"D:(A;;FA;;;{OWNER})(A;;FR;;;{other})", OWNER) == [other.upper()]


def test_deny_aces_are_ignored() -> None:
    """A deny ACE only ever narrows access, so it can never be an exposure."""
    assert _offending_trustees(f"O:BAG:BAD:AI(D;;FA;;;WD)(A;;FA;;;{OWNER})", OWNER) == []


def test_a_missing_dacl_is_treated_as_fully_exposed() -> None:
    """No DACL means 'grant everyone everything' in Windows security semantics."""
    assert _offending_trustees(f"O:BAG:BAG:{OWNER}", OWNER) == ["<no DACL>"]


def test_sacl_contents_are_not_mistaken_for_dacl_aces() -> None:
    sddl = f"O:BAG:BAD:(A;;FA;;;{OWNER})S:(AU;SAFA;FA;;;WD)"
    assert _offending_trustees(sddl, OWNER) == []


def test_owner_sid_is_matched_case_insensitively() -> None:
    assert _offending_trustees(f"D:(A;;FA;;;{OWNER.lower()})", OWNER.upper()) == []


# --- shared behaviour --------------------------------------------------------


def test_missing_file_raises_file_not_found(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        assert_secret_file_private(tmp_path / "absent")


def test_error_type_is_catchable_as_permission_error() -> None:
    assert issubclass(SecretFilePermissionError, PermissionError)


def test_restrict_hint_matches_the_platform(tmp_path: Path) -> None:
    hint = restrict_command_hint(_token(tmp_path))
    assert ("icacls" in hint) == (os.name == "nt")
    assert ("chmod 600" in hint) == (os.name != "nt")


# --- POSIX -------------------------------------------------------------------


@posix_only
def test_posix_owner_only_mode_passes(tmp_path: Path) -> None:
    path = _token(tmp_path)
    path.chmod(0o600)
    assert_secret_file_private(path, description="Discord token file") is None


@posix_only
@pytest.mark.parametrize("mode", [0o644, 0o640, 0o604, 0o666, 0o777])
def test_posix_group_or_other_readable_mode_is_rejected(tmp_path: Path, mode: int) -> None:
    path = _token(tmp_path)
    path.chmod(mode)
    with pytest.raises(SecretFilePermissionError, match="0600 or stricter"):
        assert_secret_file_private(path, description="Discord token file")


# --- Windows -----------------------------------------------------------------


def _icacls(*args: str) -> None:
    completed = subprocess.run(["icacls", *args], capture_output=True, text=True, timeout=30, check=False)
    if completed.returncode != 0:
        pytest.skip(f"icacls unavailable or refused: {completed.stderr.strip() or completed.stdout.strip()}")


@windows_only
def test_windows_locked_down_file_passes(tmp_path: Path) -> None:
    """The strictest ACL Windows can express must be accepted.

    This is the case a POSIX `mode & 0o077` check rejects outright: the file
    still reports mode 0o666, because os.stat() never reflects the DACL.
    """
    path = _token(tmp_path)
    sid, _ = _windows_owner_sid_and_sddl(path)
    _icacls(str(path), "/inheritance:r", "/grant:r", f"*{sid}:(R)")

    assert path.stat().st_mode & 0o077, "precondition: POSIX bits still look world-readable"
    assert_secret_file_private(path, description="Discord token file") is None


@windows_only
def test_windows_file_granted_to_everyone_is_rejected(tmp_path: Path) -> None:
    path = _token(tmp_path)
    sid, _ = _windows_owner_sid_and_sddl(path)
    _icacls(str(path), "/inheritance:r", "/grant:r", f"*{sid}:(R)")
    # S-1-1-0 is the well-known Everyone group; the SID form avoids locale issues.
    _icacls(str(path), "/grant", "*S-1-1-0:(R)")

    with pytest.raises(SecretFilePermissionError, match="non-owner principals"):
        assert_secret_file_private(path, description="Discord token file")


@windows_only
def test_windows_acl_read_failure_fails_closed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = _token(tmp_path)

    def boom(*_args: object, **_kwargs: object) -> None:
        raise OSError("powershell missing")

    monkeypatch.setattr(subprocess, "run", boom)
    with pytest.raises(SecretFilePermissionError, match="cannot read the ACL"):
        assert_secret_file_private(path)
