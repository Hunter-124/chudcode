"""Cross-platform privacy gate for on-disk secret files.

POSIX encodes "only the owner can read this file" as mode bits; Windows encodes
it as an NTFS discretionary ACL. ``os.stat().st_mode`` on Windows reflects only
the read-only attribute, so a plain file always reports ``0o666`` and the
strictest value ``os.chmod`` can express is ``0o444``. A POSIX ``mode & 0o077``
test is therefore not merely imprecise on Windows -- it is *unsatisfiable*, and
rejects every file including a correctly locked-down one. Each platform is
checked in the terms it actually uses.

Both platforms deliberately tolerate the platform superuser: POSIX ``0600``
never excluded ``root``, and the Windows equivalents are ``SYSTEM`` and the
local ``Administrators`` group. Excluding them would enforce a stricter
contract than the one this gate is documented to provide, and on Windows it
would be unachievable anyway.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

__all__ = [
    "SecretFilePermissionError",
    "assert_secret_file_private",
    "restrict_command_hint",
]

_SUBPROCESS_TIMEOUT = 30

# SDDL trustees that are equivalent to POSIX ``root`` for this purpose, as
# either a well-known two-letter alias or a fully expanded SID:
#   SY / S-1-5-18      -> NT AUTHORITY\SYSTEM
#   BA / S-1-5-32-544  -> BUILTIN\Administrators
#   OW                 -> OWNER RIGHTS
_WINDOWS_ALLOWED_TRUSTEES = frozenset({"SY", "BA", "OW", "S-1-5-18", "S-1-5-32-544"})

# One SDDL ACE: (AceType;AceFlags;Rights;ObjectGuid;InheritObjectGuid;AccountSid)
_SDDL_ACE_RE = re.compile(r"\(([^()]*)\)")

# The DACL runs from "D:" to the start of the SACL ("S:") or end of string.
# A SID never contains a colon, so this cannot split inside a trustee.
_SDDL_DACL_RE = re.compile(r"D:(?P<body>.*?)(?:S:|$)", re.DOTALL)

# Emits the current user's SID on line 1 and the file's SDDL on line 2. The path
# travels via the environment so no quoting or escaping of it is required.
_POWERSHELL_ACL_SNIPPET = (
    "$ErrorActionPreference='Stop';"
    "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;"
    "(Get-Acl -LiteralPath $env:ROBOMP_SECRET_FILE).Sddl"
)


class SecretFilePermissionError(PermissionError):
    """A secret file is readable by principals other than its owner.

    Subclasses :class:`PermissionError` so existing callers that catch the
    stdlib exception keep working unchanged.
    """


def restrict_command_hint(path: Path) -> str:
    """The exact command that makes ``path`` private on the running platform."""
    if os.name == "nt":
        return f'icacls "{path}" /inheritance:r /grant:r "%USERNAME%:R"'
    return f'chmod 600 "{path}"'


def _windows_owner_sid_and_sddl(path: Path) -> tuple[str, str]:
    """Return ``(current-user SID, file SDDL)`` for ``path``.

    Fails closed: any inability to read the ACL raises rather than passing a
    file whose exposure could not be established.
    """
    env = dict(os.environ)
    env["ROBOMP_SECRET_FILE"] = str(path)
    try:
        completed = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                _POWERSHELL_ACL_SNIPPET,
            ],
            capture_output=True,
            text=True,
            timeout=_SUBPROCESS_TIMEOUT,
            env=env,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise SecretFilePermissionError(f"cannot read the ACL of {path}: {exc}") from exc

    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip().splitlines()
        raise SecretFilePermissionError(
            f"cannot read the ACL of {path}: {detail[0] if detail else 'powershell failed'}"
        )

    lines = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
    if len(lines) < 2:
        raise SecretFilePermissionError(f"cannot read the ACL of {path}: unexpected powershell output")
    return lines[0].upper(), lines[1]


def _offending_trustees(sddl: str, owner_sid: str) -> list[str]:
    """Trustees granted access by ``sddl`` that are neither the owner nor a superuser.

    Deny ACEs are ignored: they only ever narrow access.
    """
    dacl = _SDDL_DACL_RE.search(sddl)
    if dacl is None:
        # No DACL at all means "grant everyone everything" in Windows security
        # semantics -- the opposite of private.
        return ["<no DACL>"]

    allowed = set(_WINDOWS_ALLOWED_TRUSTEES)
    allowed.add(owner_sid)

    offenders: list[str] = []
    for raw_ace in _SDDL_ACE_RE.findall(dacl.group("body")):
        fields = raw_ace.split(";")
        if len(fields) < 6:
            continue
        if fields[0].strip().upper().startswith("D"):
            continue
        trustee = fields[5].strip().upper()
        if not trustee or trustee in allowed or trustee in offenders:
            continue
        offenders.append(trustee)
    return offenders


def assert_secret_file_private(path: Path, *, description: str = "secret file") -> None:
    """Raise unless ``path`` is readable only by its owner (and the superuser).

    :raises FileNotFoundError: ``path`` does not exist.
    :raises SecretFilePermissionError: ``path`` is exposed to other principals,
        or its exposure could not be determined.
    """
    stat_result = path.stat()

    if os.name != "nt":
        mode = stat_result.st_mode & 0o777
        if mode & 0o077:
            raise SecretFilePermissionError(
                f"{description} permissions must be 0600 or stricter, got {mode:04o}: {path}. "
                f"Restrict it with: {restrict_command_hint(path)}"
            )
        return

    owner_sid, sddl = _windows_owner_sid_and_sddl(path)
    offenders = _offending_trustees(sddl, owner_sid)
    if offenders:
        raise SecretFilePermissionError(
            f"{description} grants access to non-owner principals ({', '.join(offenders)}): {path}. "
            f"Restrict it with: {restrict_command_hint(path)}"
        )
