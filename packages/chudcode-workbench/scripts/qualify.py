#!/usr/bin/env python3
"""Assemble, archive and execute a native, unpublished ChudCode candidate.

The report qualifies only the observed native candidate, never stable publication.
Inputs must already be built for this host; no build, signing identity selection,
provider call, publication or downstream pin change is performed here.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

sys.dont_write_bytecode = True
PACKAGE = Path(__file__).resolve().parents[1]
REPO = PACKAGE.parents[1]
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(PACKAGE / "test"))
import package_chudcode_workbench as assembler
from qualification import (
    SmokeError,
    install_cleanup_signals,
    isolated_environment,
    run_process,
)


def sha_json(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def source_evidence(revision: str | None) -> dict:
    if revision is not None:
        kind = "caller-supplied"
    elif os.environ.get("GITHUB_ACTIONS") == "true":
        revision = os.environ.get("GITHUB_SHA")
        if not revision:
            raise ValueError("GitHub Actions checkout omitted GITHUB_SHA")
        kind = "github-actions-checkout"
    else:
        kind = "unattested-local-source"
    if revision is not None and not re.fullmatch(r"[0-9a-fA-F]{40}", revision):
        raise ValueError("Source revision must be a full 40-character commit SHA")
    paths = [
        Path(__file__),
        REPO / "scripts/package_chudcode_workbench.py",
        REPO / "scripts/smoke_chudcode_workbench.py",
        PACKAGE / "test/qualification.py",
        PACKAGE / "test/windows_job.py",
        PACKAGE / "test/run_extension_host.py",
        PACKAGE / "test/index.cjs",
        assembler.CONFIG / "base.json",
        assembler.CONFIG / "product-overrides.json",
    ]
    return {
        "revision": revision.lower() if revision else None,
        "kind": kind,
        "repository": os.environ.get("GITHUB_REPOSITORY"),
        "runId": os.environ.get("GITHUB_RUN_ID"),
        "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "cleanWorkingTreeAttested": False,
        "qualificationSources": {
            str(path.relative_to(REPO)): assembler.digest(path) for path in paths
        },
    }


def inventory(root: Path) -> list[dict]:
    """Validate archive-safe entries and bind directory/file modes as well as bytes."""
    result = []
    for path in sorted(root.rglob("*")):
        name = path.relative_to(root).as_posix()
        relative = assembler.member_path(name)
        mode = path.lstat().st_mode
        entry = {"path": name}
        if stat.S_ISLNK(mode):
            value = os.readlink(path)
            assembler.link_target(relative, value)
            if not path.resolve(strict=True).is_relative_to(root.resolve()):
                raise ValueError(f"Candidate symlink escapes archive: {name}")
            entry.update(kind="symlink", link=value)
        elif stat.S_ISREG(mode):
            entry.update(
                kind="file", size=path.stat().st_size, sha256=assembler.digest(path)
            )
        elif stat.S_ISDIR(mode):
            entry.update(kind="directory")
        else:
            raise ValueError(f"Unsupported candidate entry: {name}")
        # Windows chmod cannot represent POSIX modes, but ZIP still stores modes.
        if os.name != "nt" and not stat.S_ISLNK(mode):
            entry["mode"] = stat.S_IMODE(mode)
        result.append(entry)
    return result


def download_base(pin: dict, destination: Path) -> Path:
    request = urllib.request.Request(
        pin["url"], headers={"User-Agent": "ChudCode-native-qualification"}
    )
    print(f"Downloading pinned base: {pin['url']}", file=sys.stderr)
    with (
        urllib.request.urlopen(request, timeout=120) as source,
        destination.open("xb") as output,
    ):
        if source.status != 200 or not source.url.startswith("https://"):
            raise ValueError(
                "Pinned base download did not return an HTTPS 200 response"
            )
        total = 0
        while chunk := source.read(1024 * 1024):
            total += len(chunk)
            if total > pin["size"]:
                raise ValueError("Pinned base download exceeds official size")
            output.write(chunk)
    assembler.verify_archive(destination, pin)
    return destination


def make_archive(bundle: Path, archive: Path, root_name: str, kind: str) -> None:
    inventory(bundle)  # Reject links/special entries before emitting any archive.
    if kind == "tar.gz":
        with (
            archive.open("xb") as output,
            tarfile.open(fileobj=output, mode="w:gz", dereference=False) as target,
        ):
            target.add(bundle, arcname=root_name, recursive=True)
    else:
        with zipfile.ZipFile(
            archive, mode="x", compression=zipfile.ZIP_DEFLATED, allowZip64=True
        ) as target:
            for path in [bundle, *sorted(bundle.rglob("*"))]:
                name = (
                    root_name
                    if path == bundle
                    else root_name + "/" + path.relative_to(bundle).as_posix()
                )
                mode = path.lstat().st_mode
                if stat.S_ISLNK(mode):
                    entry = zipfile.ZipInfo(name)
                    entry.create_system = 3
                    entry.external_attr = mode << 16
                    target.writestr(entry, os.readlink(path).encode("utf-8"))
                else:
                    target.write(path, arcname=name + ("/" if path.is_dir() else ""))


def observed_command(
    command: list[str], root: Path, environment: dict[str, str], timeout: float = 60
) -> dict:
    """Record unavailable optional signing observations, without promoting failures."""
    try:
        return {
            "available": True,
            "exit": 0,
            "stdout": run_process(command, root, environment, timeout),
        }
    except SmokeError as error:
        return {"available": False, "diagnostic": str(error)}


def macos_sign(bundle: Path, scratch: Path, environment: dict[str, str]) -> dict:
    """Ad-hoc reseal modified resources, preserving each original entitlement set.

    Inside-out explicit signing avoids --deep's implicit entitlement rewriting.
    This is solely a runnable candidate signature, not Developer ID/notarization.
    """
    app = bundle / "editor/VSCodium.app"
    codesign = shutil.which("codesign")
    security = shutil.which("security")
    if not codesign:
        raise ValueError(
            "macOS qualification requires codesign for the altered Electron bundle"
        )
    identities = (
        observed_command(
            [security, "find-identity", "-v", "-p", "codesigning"], scratch, environment
        )
        if security
        else {"available": False, "diagnostic": "security executable unavailable"}
    )
    original = observed_command(
        [codesign, "--verify", "--deep", "--strict", str(app)], scratch, environment
    )
    signables = []
    macho_magic = {
        b"\xcf\xfa\xed\xfe",
        b"\xce\xfa\xed\xfe",
        b"\xfe\xed\xfa\xcf",
        b"\xfe\xed\xfa\xce",
        b"\xca\xfe\xba\xbe",
        b"\xbe\xba\xfe\xca",
        b"\xca\xfe\xba\xbf",
    }
    for path in app.rglob("*"):
        if path.is_symlink():
            continue
        if path.is_dir() and path.suffix in (".app", ".framework", ".xpc", ".bundle"):
            signables.append(path)
        elif path.is_file():
            with path.open("rb") as stream:
                if stream.read(4) in macho_magic:
                    signables.append(path)
    signables.append(app)
    # Capture all entitlements before signing mutates any nested code object.
    entitlements = {}
    unsigned = set()
    for index, path in enumerate(signables):
        try:
            raw = run_process(
                [codesign, "--display", "--entitlements", ":-", str(path)],
                scratch,
                environment,
                60,
            )
        except SmokeError as error:
            if "code object is not signed at all" not in str(error):
                raise
            # New unsigned native code has no entitlements to preserve. Other
            # display failures must not silently discard upstream entitlements.
            unsigned.add(path)
            continue
        if raw:
            data = plistlib.loads(raw.encode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError(f"Invalid original Electron entitlements: {path}")
            entitlement_file = scratch / f"entitlements-{index}.plist"
            with entitlement_file.open("xb") as output:
                plistlib.dump(data, output)
            entitlements[path] = (entitlement_file, data)
    for path in sorted(
        signables, key=lambda item: (len(item.parts), str(item)), reverse=True
    ):
        command = [codesign, "--force", "--sign", "-"]
        if path not in unsigned:
            command += ["--preserve-metadata=identifier,flags"]
        if path in entitlements:
            command += ["--entitlements", str(entitlements[path][0])]
        run_process(command + [str(path)], scratch, environment, 120)
    run_process(
        [codesign, "--verify", "--deep", "--strict", str(app)],
        scratch,
        environment,
        120,
    )
    for path, (_, expected) in entitlements.items():
        raw = run_process(
            [codesign, "--display", "--entitlements", ":-", str(path)],
            scratch,
            environment,
            60,
        )
        if plistlib.loads(raw.encode("utf-8")) != expected:
            raise ValueError(f"Electron entitlements changed during re-signing: {path}")
    return {
        "status": "ad-hoc",
        "notarized": False,
        "developerIdSigned": False,
        "stableSigningQualified": False,
        "originalModifiedBundleSignature": original,
        "identityObservation": identities,
        "availableIdentityCount": len(
            re.findall(
                r"^\s*\d+\)\s+[0-9A-Fa-f]{40}\s+",
                identities.get("stdout", ""),
                re.MULTILINE,
            )
        ),
        "entitlements": {
            str(path.relative_to(bundle)): value[1]
            for path, value in entitlements.items()
        },
        "originallyUnsignedObjects": sorted(
            str(path.relative_to(bundle)) for path in unsigned
        ),
        "signedCodeObjects": len(signables),
        "strictVerification": "passed",
    }


def native_signing_observation(
    bundle: Path, target: str, scratch: Path, environment: dict[str, str]
) -> dict:
    if target == "darwin-x64":
        return macos_sign(bundle, scratch, environment)
    result = {"status": "not-signed-by-qualification", "stableSigningQualified": False}
    if target == "win32-x64":
        powershell = shutil.which("powershell") or shutil.which("pwsh")
        if powershell:
            result["identityObservations"] = {}
            for store in ("CurrentUser", "LocalMachine"):
                script = (
                    "$ErrorActionPreference='Stop'; "
                    f"$certificates=@(Get-ChildItem Cert:\\{store}\\My -CodeSigningCert | "
                    "Select-Object Thumbprint,Subject,NotBefore,NotAfter,HasPrivateKey); "
                    f"@{{Store='{store}'; Certificates=$certificates; Count=$certificates.Count}} | "
                    "ConvertTo-Json -Depth 4 -Compress"
                )
                result["identityObservations"][store] = observed_command(
                    [powershell, "-NoProfile", "-NonInteractive", "-Command", script],
                    scratch,
                    environment,
                )
            signatures = {}
            for name in (
                "chudcode-desktop.exe",
                "chudcode-service.exe",
                "chud.exe",
                "editor/VSCodium.exe",
            ):
                escaped = str(bundle / name).replace("'", "''")
                script = (
                    "$ErrorActionPreference='Stop'; "
                    f"Get-AuthenticodeSignature -LiteralPath '{escaped}' | "
                    "Select-Object Status,StatusMessage,Path,"
                    "@{Name='SignerCertificate'; Expression={"
                    "$_.SignerCertificate | Select-Object Thumbprint,Subject,NotBefore,NotAfter}} | "
                    "ConvertTo-Json -Depth 4 -Compress"
                )
                signatures[name] = observed_command(
                    [powershell, "-NoProfile", "-NonInteractive", "-Command", script],
                    scratch,
                    environment,
                )
            result["authenticodeObservations"] = signatures
        else:
            result["identityObservations"] = {
                store: {
                    "available": False,
                    "diagnostic": "PowerShell signing observation unavailable",
                }
                for store in ("CurrentUser", "LocalMachine")
            }
    else:
        result["identityObservation"] = {
            "applicable": False,
            "reason": "No Linux code-signing identity is selected by this lane",
        }
    return result


def json_probe(
    command: list[str], scratch: Path, environment: dict[str, str], timeout: float
) -> dict:
    raw = run_process(command, scratch, environment, timeout)
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise SmokeError(f"Native probe did not return a JSON object: {command}")
    return value


def qualify(options: argparse.Namespace) -> dict:
    target = f"{sys.platform}-x64"
    assembler.require_native_host(target)
    pins = assembler.load_json(assembler.CONFIG / "base.json")
    pin = pins["targets"][target]
    source = source_evidence(options.source_revision)
    output = Path(os.path.abspath(options.output.expanduser()))
    output.mkdir(parents=True, exist_ok=True)
    root_name = f"chudcode-workbench-{target}"
    kind = "zip" if target == "win32-x64" else "tar.gz"
    destinations = {
        "candidate": output / f"candidate-{target}",
        "archive": output / f"{root_name}.{kind}",
        "checksum": output / f"{root_name}.{kind}.sha256",
        "report": output / f"workbench-qualification-{target}.json",
    }
    for destination in destinations.values():
        if os.path.lexists(destination):
            raise ValueError(
                f"Refusing to overwrite qualification output: {destination}"
            )
    suffix = ".exe" if target == "win32-x64" else ""
    engine = options.engine.expanduser().resolve(strict=True)
    # Keep private runtime/socket paths short even under a deep CI artifact root.
    with (
        tempfile.TemporaryDirectory(
            prefix=".workbench-qualifying-", dir=output
        ) as directory,
        tempfile.TemporaryDirectory(
            prefix="ccq-", dir="/tmp" if os.name != "nt" else None
        ) as state_directory,
    ):
        scratch = Path(directory).resolve()
        state = Path(state_directory).resolve()
        environment = isolated_environment(state)
        base = (
            options.base_archive.expanduser().resolve(strict=True)
            if options.base_archive
            else download_base(pin, scratch / pin["name"])
        )
        assembler.verify_archive(base, pin)
        bundle = assembler.assemble(
            argparse.Namespace(
                target=target,
                output=scratch / "candidate",
                base_archive=base,
                launcher=options.launcher,
                service=engine / ("chudcode-service" + suffix),
                chud=engine / ("chud" + suffix),
                extension=options.extension,
            )
        )
        signing = native_signing_observation(bundle, target, state, environment)
        print(
            json.dumps({"nativeSigningObservation": signing}, sort_keys=True),
            file=sys.stderr,
        )
        # Re-signing changes Electron binaries/resources: bind the resulting bytes.
        manifest_path = bundle / "candidate-manifest.json"
        manifest = assembler.load_json(manifest_path)
        manifest["qualification"]["signing"] = signing["status"]
        manifest["files"] = assembler.file_inventory(bundle)
        manifest["files"] = [
            entry
            for entry in manifest["files"]
            if entry["path"] != "candidate-manifest.json"
        ]
        assembler.dump_json(manifest_path, manifest)
        expected = inventory(bundle)
        archive = scratch / destinations["archive"].name
        make_archive(bundle, archive, root_name, kind)
        archive_sha = assembler.digest(archive)
        # Execute the extracted distributable, not just its pre-archive source.
        unpacked = scratch / "roundtrip"
        assembler.extract_archive(archive, unpacked, kind)
        tested = unpacked / root_name
        if inventory(tested) != expected:
            raise ValueError(
                "Distributable archive roundtrip changed contents, links or modes"
            )
        print(
            f"Running native worker, smoke and extension-host probes: {target}",
            file=sys.stderr,
        )
        workers = {}
        for name in ("chud" + suffix, "chudcode-service" + suffix):
            raw = run_process(
                [str(tested / name), "--smoke-test"], state, environment, 600
            )
            if "smoke-test: ok" not in raw.splitlines():
                raise ValueError(
                    f"Worker probe omitted its successful completion marker: {name}"
                )
            workers[name] = {
                "exit": 0,
                "stdout": raw,
                "sha256": assembler.digest(tested / name),
            }
        smoke = json_probe(
            [
                sys.executable,
                str(REPO / "scripts/smoke_chudcode_workbench.py"),
                "--bundle",
                str(tested),
            ],
            state,
            environment,
            300,
        )
        if (
            smoke.get("launcher_check") != "passed"
            or smoke.get("target") != target
            or smoke.get("version") != pins["productVersion"]
            or smoke.get("launcher_sha256")
            != assembler.digest(tested / ("chudcode-desktop" + suffix))
        ):
            raise ValueError("Smoke evidence does not match this native candidate")
        command = [
            sys.executable,
            str(PACKAGE / "test/run_extension_host.py"),
            "--bundle",
            str(tested),
        ]
        if target == "linux-x64":
            xvfb = shutil.which("xvfb-run")
            if xvfb is None:
                raise ValueError(
                    "Native Linux extension-host qualification requires xvfb-run"
                )
            command = [xvfb, "-a", "-e", "/dev/stderr", *command]
        extension_host = json_probe(command, state, environment, 300)
        if (
            extension_host.get("qualification") != "real-code-oss-extension-host-only"
            or extension_host.get("editor_exit") != 0
            or extension_host.get("target") != target
            or extension_host.get("version") != pins["productVersion"]
        ):
            raise ValueError(
                "Extension-host evidence does not match this native candidate"
            )
        if (
            inventory(tested) != expected
            or inventory(bundle) != expected
            or assembler.digest(archive) != archive_sha
        ):
            raise ValueError("Candidate or archive changed during native qualification")
        # Bind scripts as executed; reject concurrent source changes as well.
        if source_evidence(options.source_revision) != source:
            raise ValueError("Qualification source changed during native execution")
        checks = {
            "workers": workers,
            "candidateSmoke": smoke,
            "extensionHost": extension_host,
            "archiveRoundtrip": "passed",
            "postExecutionIntegrity": "passed",
        }
        report = {
            "schemaVersion": 1,
            "kind": "chudcode-workbench-native-qualification",
            "qualified": True,
            "stable_ready": False,
            "stablePublication": False,
            "target": target,
            "version": pins["productVersion"],
            "observedAt": datetime.now(timezone.utc).isoformat(),
            "host": {
                "system": platform.system(),
                "release": platform.release(),
                "machine": platform.machine(),
                "python": platform.python_version(),
            },
            "source": source,
            "upstream": {
                "name": pin["name"],
                "url": pin["url"],
                "sha256": pin["sha256"],
                "size": pin["size"],
                "integrity": "passed",
            },
            "archive": {
                "name": archive.name,
                "sha256": archive_sha,
                "size": archive.stat().st_size,
                "root": root_name,
            },
            "manifest": {
                "path": "candidate-manifest.json",
                "sha256": assembler.digest(manifest_path),
            },
            "binaries": {
                name: {"path": relative, "sha256": assembler.digest(tested / relative)}
                for name, relative in manifest["layout"].items()
                if name in ("launcher", "service", "chud", "editor")
            },
            "payloadInventorySha256": sha_json(expected),
            "payloadInventory": expected,
            "checks": checks,
            "signing": signing,
            "nativeCpu": {
                "requestedVariant": environment.get("PI_NATIVE_VARIANT", "automatic"),
                "baselineHardwareQualified": False,
            },
            "unqualified_gates": [
                "stable platform signing/notarization",
                "baseline-only CPU hardware execution",
                "live provider/OAuth (not invoked by this command)",
                "CAD deployed-consumer smoke",
                "CloudCastle deployed integration",
                "interactive webview/UI capture",
                "native terminal interaction",
                "other native targets (this report covers only " + target + ")",
            ]
            + (
                ["exact source revision attestation"]
                if source["revision"] is None
                else []
            ),
        }
        checksum = scratch / destinations["checksum"].name
        checksum.write_text(f"{archive_sha}  {archive.name}\n", encoding="utf-8")
        report_path = scratch / destinations["report"].name
        assembler.dump_json(report_path, report)
        # Report is the final commit marker. Every publication is atomic/no-replace.
        assembler.publish_directory(bundle, destinations["candidate"])
        assembler.publish_directory(archive, destinations["archive"])
        assembler.publish_directory(checksum, destinations["checksum"])
        assembler.publish_directory(report_path, destinations["report"])
    return {key: str(value) for key, value in destinations.items()}


def main() -> int:
    install_cleanup_signals()
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("output", "launcher", "engine"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--base-archive", type=Path)
    parser.add_argument("--extension", type=Path, default=PACKAGE)
    parser.add_argument(
        "--source-revision",
        help="Full source commit SHA; recorded as caller-supplied, never as a clean-tree attestation",
    )
    options = parser.parse_args()
    try:
        result = qualify(options)
    except (
        SmokeError,
        OSError,
        ValueError,
        KeyError,
        RuntimeError,
        subprocess.SubprocessError,
        tarfile.TarError,
        zipfile.BadZipFile,
        KeyboardInterrupt,
    ) as error:
        print(
            f"Native qualification FAILED: {type(error).__name__}: {error}",
            file=sys.stderr,
        )
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
