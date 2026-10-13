#!/usr/bin/env python3
"""Assemble a local, unpublished Code-OSS candidate using Python's standard library.

Example (all inputs are local, already built; no download or build is implicit):
  python3 scripts/package_chudcode_workbench.py --target linux-x64 \
    --base-archive /tmp/VSCodium-linux-x64-1.135.06055.tar.gz \
    --launcher target/release/chudcode-desktop --service /tmp/chudcode-service \
    --chud /tmp/chud --extension packages/chudcode-workbench --output /tmp/workbench

The binary inputs must be native x64 executables for --target, not source launchers.
Assembly must run on that target's native host: executable role/version probes are
required before publication; cross-host assembly fails closed. The --extension
input must contain its built dist outputs. Required repository and upstream notices
are preserved. A completed candidate directory is published atomically without
replacing an existing output. This does not publish, sign, or replace stable releases.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import platform
import plistlib
import re
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

REPO = Path(__file__).resolve().parent.parent
CONFIG = REPO / "packaging" / "workbench"
MAX_EXTRACTED_BYTES = 8 * 1024**3
MAX_MEMBERS = 200_000
RESERVED_NAMES = {
    "con",
    "prn",
    "aux",
    "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
}


def fail(message: str) -> None:
    raise ValueError(message)


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as source:
        value = json.load(source)
    if not isinstance(value, dict):
        fail(f"Expected JSON object: {path}")
    return value


def dump_json(path: Path, value: dict) -> None:
    path.write_text(
        json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def digest(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def verify_archive(path: Path, pin: dict) -> None:
    if not path.is_file() or path.stat().st_size != pin["size"]:
        fail(f"Archive size mismatch: expected {pin['size']} bytes for {pin['name']}")
    actual = digest(path)
    if actual != pin["sha256"]:
        fail(f"Archive SHA256 mismatch for {pin['name']}: {actual}")


def member_path(name: str) -> PurePosixPath:
    if "\\" in name or "\x00" in name or name.startswith("/"):
        fail(f"Unsafe archive path: {name!r}")
    parts = []
    for part in name.split("/"):
        if part in ("", "."):
            continue
        if (
            part == ".."
            or ":" in part
            or part.endswith((".", " "))
            or part.split(".")[0].lower() in RESERVED_NAMES
        ):
            fail(f"Unsafe archive path: {name!r}")
        parts.append(part)
    return PurePosixPath(*parts)


def link_target(path: PurePosixPath, value: str) -> PurePosixPath:
    if not value or value.startswith("/") or "\\" in value or "\x00" in value:
        fail(f"Unsafe link target: {path} -> {value!r}")
    parts = list(path.parent.parts)
    for part in value.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if not parts:
                fail(f"Escaping link target: {path} -> {value!r}")
            parts.pop()
        else:
            member_path(part)
            parts.append(part)
    return PurePosixPath(*parts)


def checked_destination(root: Path, relative: PurePosixPath) -> Path:
    destination = root.joinpath(*relative.parts)
    if not destination.resolve().is_relative_to(root.resolve()):
        fail(f"Extraction escapes output: {relative}")
    return destination


def extract_archive(archive: Path, root: Path, kind: str) -> None:
    """Extract regular files first; links last, never traversing a link parent."""
    root.mkdir()
    seen: dict[PurePosixPath, str] = {}
    links: list[tuple[PurePosixPath, str, bool]] = []
    directory_modes: list[tuple[Path, int]] = []
    total = 0

    def register(name: str, entry_kind: str, size: int, mode: int) -> Path:
        nonlocal total
        relative = member_path(name)
        if not relative.parts and entry_kind != "directory":
            fail(f"Invalid archive root member: {name!r}")
        if relative in seen and not (seen[relative] == entry_kind == "directory"):
            fail(f"Duplicate archive member: {name!r}")
        seen[relative] = entry_kind
        total += size
        if len(seen) > MAX_MEMBERS or total > MAX_EXTRACTED_BYTES or size < 0:
            fail("Archive exceeds extraction limits")
        destination = checked_destination(root, relative)
        if entry_kind == "directory":
            destination.mkdir(parents=True, exist_ok=True)
            directory_modes.append((destination, mode & 0o777))
        elif entry_kind == "file":
            destination.parent.mkdir(parents=True, exist_ok=True)
        return destination

    if kind == "tar.gz":
        with tarfile.open(archive, "r:gz") as source:
            for entry in source:
                if entry.isdir():
                    register(entry.name, "directory", 0, entry.mode)
                elif entry.isfile():
                    destination = register(entry.name, "file", entry.size, entry.mode)
                    stream = source.extractfile(entry)
                    if stream is None:
                        fail(f"Missing archive file data: {entry.name}")
                    with stream, destination.open("xb") as output:
                        shutil.copyfileobj(stream, output)
                    destination.chmod(entry.mode & 0o777)
                elif entry.issym() or entry.islnk():
                    register(entry.name, "link", 0, 0)
                    links.append(
                        (member_path(entry.name), entry.linkname, entry.islnk())
                    )
                else:
                    fail(f"Unsupported archive member type: {entry.name}")
    elif kind == "zip":
        with zipfile.ZipFile(archive) as source:
            for entry in source.infolist():
                mode = entry.external_attr >> 16
                if entry.flag_bits & 1:
                    fail(f"Encrypted archive member: {entry.filename}")
                if entry.is_dir():
                    register(entry.filename, "directory", 0, mode or 0o755)
                elif stat.S_ISLNK(mode):
                    register(entry.filename, "link", entry.file_size, 0)
                    if entry.file_size > 4096:
                        fail(f"Oversized symlink: {entry.filename}")
                    links.append(
                        (
                            member_path(entry.filename),
                            source.read(entry).decode("utf-8"),
                            False,
                        )
                    )
                elif stat.S_IFMT(mode) in (0, stat.S_IFREG):
                    destination = register(
                        entry.filename, "file", entry.file_size, mode
                    )
                    with source.open(entry) as stream, destination.open("xb") as output:
                        shutil.copyfileobj(stream, output)
                    destination.chmod((mode & 0o777) or 0o644)
                else:
                    fail(f"Unsupported zip member type: {entry.filename}")
    else:
        fail(f"Unsupported archive format: {kind}")

    for path in seen:
        if any(seen.get(parent) == "link" for parent in path.parents):
            fail(f"Archive member traverses symlink: {path}")
    for relative, value, hard in links:
        target = member_path(value) if hard else link_target(relative, value)
        destination = checked_destination(root, relative)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists() or destination.is_symlink():
            fail(f"Archive link conflicts with existing path: {relative}")
        if hard:
            source = checked_destination(root, target)
            if not source.is_file() or source.is_symlink():
                fail(f"Invalid archive hardlink: {relative} -> {value}")
            os.link(source, destination)
        else:
            os.symlink(value, destination)
    for relative, _, _ in links:
        destination = root.joinpath(*relative.parts)
        try:
            resolved = destination.resolve(strict=True)
        except (OSError, RuntimeError) as error:
            fail(f"Broken or cyclic archive link {relative}: {error}")
        if not resolved.is_relative_to(root.resolve()):
            fail(f"Archive link escapes output: {relative}")
    for destination, mode in reversed(directory_modes):
        destination.chmod(mode or 0o755)


def native_binary(path: Path, target: str) -> None:
    if not path.is_file() or path.is_symlink():
        fail(f"Expected a regular native executable: {path}")
    with path.open("rb") as source:
        header = source.read(64)
        if target == "linux-x64":
            valid = (
                len(header) == 64
                and header[:6] == b"\x7fELF\x02\x01"
                and struct.unpack_from("<H", header, 18)[0] == 62
                and struct.unpack_from("<H", header, 16)[0] in (2, 3)
            )
        elif target == "darwin-x64":
            valid = (
                len(header) == 64
                and header[:4] == b"\xcf\xfa\xed\xfe"
                and struct.unpack_from("<I", header, 4)[0] == 0x01000007
                and struct.unpack_from("<I", header, 12)[0] == 2
            )
        elif target == "win32-x64":
            valid = False
            if len(header) == 64 and header[:2] == b"MZ":
                offset = struct.unpack_from("<I", header, 60)[0]
                if 64 <= offset <= path.stat().st_size - 26:
                    source.seek(offset)
                    pe = source.read(26)
                    valid = (
                        pe[:4] == b"PE\0\0"
                        and struct.unpack_from("<H", pe, 4)[0] == 0x8664
                        and struct.unpack_from("<H", pe, 24)[0] == 0x20B
                    )
        else:
            fail(f"Unsupported target: {target}")
    if not valid:
        fail(
            f"Executable is not native {target} (scripts and source shims are forbidden): {path}"
        )
    if target != "win32-x64" and not path.stat().st_mode & 0o111:
        fail(f"Native executable has no executable mode: {path}")


def require_native_host(target: str) -> None:
    host = {"linux": "linux", "darwin": "darwin", "win32": "win32"}.get(sys.platform)
    if platform.machine().lower() not in ("x86_64", "amd64") or target != f"{host}-x64":
        fail(f"Assembly requires a native {target} host for executable identity probes")


def binary_evidence(path: Path, role: str, version: str, target: str) -> dict:
    """Probe the actual executable, not adjacent metadata or a header fixture."""
    require_native_host(target)
    native_binary(path, target)
    before = digest(path)
    argument = "--version" if role == "chud" else "--build-info"
    environment = os.environ.copy()
    for name in (
        "BUN_BE_BUN",
        "ELECTRON_RUN_AS_NODE",
        "CHUDCODE_WORKBENCH_SERVICE",
        "CHUDCODE_WORKBENCH_SERVICE_ARGS",
    ):
        environment.pop(name, None)
    try:
        result = subprocess.run(
            [str(path), argument],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="strict",
            env=environment,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired, UnicodeError) as error:
        fail(f"Cannot probe {role} executable identity: {path}: {error}")
    if result.returncode != 0 or result.stderr.strip():
        fail(f"{role} executable identity probe failed: {path}")
    output = result.stdout.strip()
    if role == "chud":
        valid = output == f"Chudcode v{version}"
    else:
        try:
            info = json.loads(output)
        except ValueError:
            info = None
        valid = (
            isinstance(info, dict)
            and info.get("role") == role
            and info.get("version") == version
        )
    if not valid:
        fail(f"{role} executable role/version mismatch (expected {version}): {path}")
    if digest(path) != before:
        fail(f"Executable changed during identity probe: {path}")
    return {
        "role": role,
        "version": version,
        "sha256": before,
        "probe": argument,
        "stdout": output,
        "hostTarget": target,
    }


def copy_repository_notices(destination: Path) -> list[str]:
    names = ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.txt"]
    for name in names:
        path = REPO / name
        if not path.is_file() or path.is_symlink() or not path.stat().st_size:
            fail(f"Missing required compatibility-engine notice: {path}")
    for name in (*names, "LICENSE.txt", "LICENSE.md"):
        path = REPO / name
        if path.is_file() and not path.is_symlink():
            shutil.copy2(path, destination / ("Chudcode-" + name))
    return ["notices/Chudcode-" + name for name in names]


def publish_directory(staging: Path, output: Path) -> None:
    """One native atomic rename, with no replace even if output appears concurrently."""
    if sys.platform == "win32":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        move = kernel.MoveFileExW
        move.argtypes = (ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32)
        move.restype = ctypes.c_int
        if not move(str(staging), str(output), 0):
            raise ctypes.WinError(ctypes.get_last_error())
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "linux":
        rename = getattr(libc, "renameat2", None)
        if rename is None:
            fail("Atomic no-replace publication requires Linux renameat2")
        rename.argtypes = (
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        )
        rename.restype = ctypes.c_int
        result = rename(-100, os.fsencode(staging), -100, os.fsencode(output), 1)
    elif sys.platform == "darwin":
        rename = libc.renamex_np
        rename.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint)
        rename.restype = ctypes.c_int
        result = rename(os.fsencode(staging), os.fsencode(output), 4)
    else:
        fail("Atomic candidate publication is unsupported on this host")
    if result != 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number), str(output))


def copy_extension(source: Path, destination: Path) -> dict:
    package = load_json(source / "package.json")
    if (
        package.get("publisher") != "chudware"
        or package.get("name") != "chudcode-workbench"
        or package.get("main") != "./dist/extension.cjs"
    ):
        fail("Extension must be the built chudware.chudcode-workbench package")
    for required in (
        "dist/extension.cjs",
        "dist/webview/index.js",
        "dist/webview/index.css",
    ):
        path = source / required
        if not path.is_file() or path.is_symlink() or not path.stat().st_size:
            fail(f"Missing built extension output: {path}")
    dist = source / "dist"
    for path in dist.rglob("*"):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            fail(f"Unsupported extension payload entry: {path}")
        if path.is_file() and (
            path.suffix in (".ts", ".tsx", ".map") or path.name.endswith(".d.ts")
        ):
            fail(f"Source/build-only file in extension dist: {path}")
    destination.mkdir()
    shutil.copy2(source / "package.json", destination / "package.json")
    shutil.copytree(dist, destination / "dist")
    for name in ("LICENSE", "LICENSE.txt", "NOTICE", "NOTICE.txt", "README.md"):
        path = source / name
        if path.is_file() and not path.is_symlink():
            shutil.copy2(path, destination / name)
    return package


def overlay_product(app: Path, overrides: dict, version: str) -> None:
    path = app / "product.json"
    product = load_json(path)
    # Remove updater/installer identities rather than retaining VSCodium aliases.
    for key in list(product):
        if key in (
            "updateUrl",
            "downloadUrl",
            "win32UpdateUrl",
            "darwinUniversalAssetId",
        ) or (key.startswith("win32") and key.endswith("AppId")):
            del product[key]
    product.update(overrides)
    product["chudcodeVersion"] = version
    gallery = product.get("extensionsGallery", {})
    if gallery.get(
        "serviceUrl"
    ) != "https://open-vsx.org/vscode/gallery" or product.get("updateUrl"):
        fail("Product overlay must keep Open VSX and disable upstream auto-update")
    dump_json(path, product)
    # Upstream Electron/VS Code version stays intact: extension APIs depend on it.


def brand_macos(editor: Path) -> None:
    path = editor / "VSCodium.app" / "Contents" / "Info.plist"
    with path.open("rb") as source:
        info = plistlib.load(source)
    # Electron's pre-JavaScript helper lookup uses CFBundleName as the prefix of
    # "<name> Helper[ (Renderer|GPU|Plugin)].app/Contents/MacOS/<name> Helper...".
    # Preserve that name and all upstream executable/helper identities; only the
    # display name is branding. VS Code selects userData via product.nameShort,
    # not CFBundleName, so the Chudcode product overlay still isolates profiles.
    info.update(
        CFBundleDisplayName="Chudcode Workbench",
        CFBundleIdentifier="dev.chudware.chudcode.workbench",
    )
    for entry in info.get("CFBundleURLTypes", []):
        entry["CFBundleURLName"] = "Chudcode Workbench"
        entry["CFBundleURLSchemes"] = ["chudcode-workbench"]
    with path.open("wb") as output:
        plistlib.dump(info, output)


def file_inventory(root: Path) -> list[dict]:
    inventory = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            inventory.append({"path": relative, "link": os.readlink(path)})
        elif path.is_file():
            inventory.append(
                {"path": relative, "size": path.stat().st_size, "sha256": digest(path)}
            )
    return inventory


def assemble(options: argparse.Namespace) -> Path:
    pins = load_json(CONFIG / "base.json")
    pin = pins["targets"][options.target]
    version = pins["productVersion"]
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", version):
        fail("Invalid pinned product version")
    output = Path(os.path.abspath(options.output))
    # lexists includes broken symlinks; resolving output first would miss them.
    if os.path.lexists(output):
        fail(f"Refusing to overwrite existing output: {output}")
    require_native_host(options.target)
    inputs = {
        key: Path(getattr(options, key)).expanduser().resolve(strict=True)
        for key in ("base_archive", "launcher", "service", "chud", "extension")
    }
    evidence = {
        key: binary_evidence(inputs[key], role, version, options.target)
        for key, role in (
            ("launcher", "chudcode-desktop"),
            ("service", "chudcode-service"),
            ("chud", "chud"),
        )
    }
    verify_archive(inputs["base_archive"], pin)
    if not inputs["extension"].is_dir():
        fail("--extension must be a built extension directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.assembling-", dir=output.parent)
    )
    try:
        editor = staging / "editor"
        extract_archive(inputs["base_archive"], editor, pin["archive"])
        executable = editor / pin["editor"]
        native_binary(executable, options.target)
        app = editor / pin["app"]
        upstream_package = load_json(app / "package.json")
        if not str(upstream_package.get("version", "")).startswith("1.135."):
            fail("Pinned editor does not implement the expected VS Code 1.135 API")
        overlay_product(app, load_json(CONFIG / "product-overrides.json"), version)
        if options.target == "darwin-x64":
            brand_macos(editor)
        extension = copy_extension(
            inputs["extension"], app / "extensions" / "chudcode-workbench"
        )
        suffix = ".exe" if options.target == "win32-x64" else ""
        for key, name in (
            ("launcher", "chudcode-desktop"),
            ("service", "chudcode-service"),
            ("chud", "chud"),
        ):
            destination = staging / (name + suffix)
            shutil.copy2(inputs[key], destination)
            if digest(destination) != evidence[key]["sha256"]:
                fail(f"Executable changed after identity probe: {inputs[key]}")
            if options.target != "win32-x64":
                destination.chmod(destination.stat().st_mode | 0o755)
        (staging / "VERSION").write_text(version + "\n", encoding="utf-8")
        notices = staging / "notices"
        notices.mkdir()
        preserved = []
        for path in editor.rglob("*"):
            if (
                path.is_file()
                and not path.is_symlink()
                and re.match(
                    r"^(license|notice|thirdpartynotices)", path.name, re.IGNORECASE
                )
            ):
                preserved.append(path.relative_to(staging).as_posix())
        if not any(Path(name).name.lower().startswith("license") for name in preserved):
            fail("Pinned editor distribution is missing its upstream license")
        repository_notices = copy_repository_notices(notices)
        (notices / "PROVENANCE.txt").write_text(
            f"Chudcode Workbench {version}: unpublished compatibility-first candidate.\n"
            f"Code-OSS binary base: VSCodium {pins['release']} ({pins['sourceUrl']}).\n"
            f"Official GitHub asset {pin['assetId']}: {pin['url']}\n"
            f"Archive SHA256: {pin['sha256']}; size: {pin['size']} bytes.\n"
            "Upstream LICENSE and third-party notices remain in editor/.\n"
            "Launcher: Rust standard library. Editor: Electron/Node.\n"
            "Agent/service/CLI: existing Bun-compiled compatibility engine, not a native Rust agent.\n"
            "Extensions: Open VSX, not Microsoft's Marketplace. Upstream auto-update disabled.\n"
            "This candidate is not built or signed by Microsoft. Product modifications invalidate\n"
            "upstream resource signatures; signing/notarization and platform qualification are pending.\n",
            encoding="utf-8",
        )
        manifest = {
            "schemaVersion": 1,
            "kind": "chudcode-workbench-candidate",
            "version": version,
            "target": options.target,
            "stablePublication": False,
            "upstream": {
                "repository": pins["upstream"],
                "release": pins["release"],
                "sourceApi": pins["sourceApi"],
                **pin,
            },
            "layout": {
                "launcher": "chudcode-desktop" + suffix,
                "service": "chudcode-service" + suffix,
                "chud": "chud" + suffix,
                "editor": "editor/" + pin["editor"],
                "extension": "editor/" + pin["app"] + "/extensions/chudcode-workbench",
            },
            "extension": {
                "id": "chudware.chudcode-workbench",
                "version": extension.get("version"),
                "engines": extension.get("engines"),
            },
            "runtime": {
                "launcher": "Rust std",
                "workbench": "Electron/Node",
                "engine": "existing Bun-compiled compatibility engine",
            },
            "qualification": {
                "linux": "not-run-by-assembler",
                "darwin": "not-run-by-assembler",
                "win32": "not-run-by-assembler",
                "signing": "not-performed",
                "stable": False,
                "nativeIsa": "unresolved-requires-native-builder-qualification",
            },
            "upstreamNotices": sorted(preserved),
            "repositoryNotices": repository_notices,
            "binaryEvidence": evidence,
            "files": file_inventory(staging),
        }
        dump_json(staging / "candidate-manifest.json", manifest)
        publish_directory(staging, output)
        return output
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--target", required=True, choices=("linux-x64", "darwin-x64", "win32-x64")
    )
    for name in ("base-archive", "launcher", "service", "chud", "extension", "output"):
        parser.add_argument("--" + name, required=True)
    options = parser.parse_args()
    try:
        output = assemble(options)
    except (
        OSError,
        ValueError,
        KeyError,
        tarfile.TarError,
        zipfile.BadZipFile,
    ) as error:
        print(f"package_chudcode_workbench: {error}", file=sys.stderr)
        return 1
    print(
        json.dumps(
            {
                "output": str(output),
                "manifest": str(output / "candidate-manifest.json"),
                "candidate": True,
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
