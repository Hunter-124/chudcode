"""Candidate integrity/publication tests plus opt-in probes of real built consumers.

Set CHUDCODE_ASSEMBLER_LAUNCHER, CHUDCODE_ASSEMBLER_SERVICE and
CHUDCODE_ASSEMBLER_CHUD to native compiled inputs to exercise all identity probes.
Set CHUDCODE_ASSEMBLER_BASE_ARCHIVE additionally to assemble the complete candidate.
No test substitutes a passing native-header fixture for executable identity evidence.
"""

import argparse
import hashlib
import importlib.util
import io
import json
import os
import platform
import plistlib
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

SCRIPT = (
    Path(__file__).resolve().parents[2] / "scripts" / "package_chudcode_workbench.py"
)
SPEC = importlib.util.spec_from_file_location("workbench_assembler", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
assembler = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(assembler)


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def tar(self, entries):
        path = self.root / "base.tar.gz"
        with tarfile.open(path, "w:gz") as archive:
            for name, data, target in entries:
                info = tarfile.TarInfo(name)
                if target is not None:
                    info.type = tarfile.SYMTYPE
                    info.linkname = target
                    archive.addfile(info)
                else:
                    info.mode = 0o755
                    info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))
        return path

    def test_integrity_rejects_same_size_modified_archive(self):
        path = self.root / "integrity.bin"
        path.write_bytes(b"original")
        pin = {
            "name": path.name,
            "size": 8,
            "sha256": hashlib.sha256(b"original").hexdigest(),
        }
        assembler.verify_archive(path, pin)
        path.write_bytes(b"modified")
        with self.assertRaisesRegex(ValueError, "SHA256 mismatch"):
            assembler.verify_archive(path, pin)
        path.write_bytes(b"short")
        with self.assertRaisesRegex(ValueError, "size mismatch"):
            assembler.verify_archive(path, pin)

    def test_tar_preserves_contents_mode_and_safe_symlink(self):
        archive = self.tar(
            [("./resources/file", b"payload", None), ("resources/link", b"", "file")]
        )
        output = self.root / "editor"
        assembler.extract_archive(archive, output, "tar.gz")
        self.assertEqual((output / "resources/link").read_bytes(), b"payload")
        self.assertEqual(os.readlink(output / "resources/link"), "file")
        self.assertEqual((output / "resources/file").stat().st_mode & 0o777, 0o755)

    def test_tar_rejects_traversal_and_escaping_links(self):
        for entries in [
            [("../outside", b"payload", None)],
            [("/absolute", b"payload", None)],
            [("link", b"", "../outside")],
            [("link", b"", "/outside")],
        ]:
            with self.subTest(entries=entries):
                output = self.root / ("editor-" + str(len(list(self.root.iterdir()))))
                with self.assertRaises(ValueError):
                    assembler.extract_archive(self.tar(entries), output, "tar.gz")
        self.assertFalse((self.root / "outside").exists())

    def test_tar_rejects_link_parent_and_duplicate_files(self):
        for entries in [
            [("dir", b"", "target"), ("dir/file", b"payload", None)],
            [("file", b"one", None), ("file", b"two", None)],
        ]:
            with self.subTest(entries=entries):
                output = self.root / ("editor-" + str(len(list(self.root.iterdir()))))
                with self.assertRaises(ValueError):
                    assembler.extract_archive(self.tar(entries), output, "tar.gz")

    def test_zip_preserves_safe_macos_framework_links(self):
        path = self.root / "base.zip"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("App/Framework/Versions/A/library", b"library contents")
            link = zipfile.ZipInfo("App/Framework/Versions/Current")
            link.create_system = 3
            link.external_attr = 0o120777 << 16
            archive.writestr(link, b"A")
        output = self.root / "editor"
        assembler.extract_archive(path, output, "zip")
        self.assertEqual(
            (output / "App/Framework/Versions/Current/library").read_bytes(),
            b"library contents",
        )

    def test_zip_rejects_windows_path_aliases(self):
        for name in (
            "../outside",
            "C:/outside",
            "folder\\outside",
            "aux.txt",
            "folder./file",
        ):
            with self.subTest(name=name):
                path = self.root / "bad.zip"
                with zipfile.ZipFile(path, "w") as archive:
                    archive.writestr(name, b"payload")
                output = self.root / ("editor-" + str(len(list(self.root.iterdir()))))
                with self.assertRaises(ValueError):
                    assembler.extract_archive(path, output, "zip")

    def test_binary_inputs_reject_source_shims(self):
        script = self.root / "launcher"
        script.write_text("#!/bin/sh\nexec editor\n", encoding="utf-8")
        script.chmod(0o755)
        for target in ("linux-x64", "darwin-x64", "win32-x64"):
            with (
                self.subTest(target=target),
                self.assertRaisesRegex(ValueError, "not native"),
            ):
                assembler.native_binary(script, target)

    def test_native_header_without_executable_behavior_is_rejected(self):
        if sys.platform != "linux" or platform.machine().lower() not in (
            "x86_64",
            "amd64",
        ):
            self.skipTest("This malformed native header regression is Linux-specific")
        path = self.root / "header-only"
        header = bytearray(64)
        header[:6] = b"\x7fELF\x02\x01"
        header[16:20] = b"\x02\x00\x3e\x00"
        path.write_bytes(header)
        path.chmod(0o755)
        assembler.native_binary(path, "linux-x64")
        with self.assertRaisesRegex(ValueError, "Cannot probe"):
            assembler.binary_evidence(path, "chud", "0.4.3", "linux-x64")

    def test_required_compatibility_notices_are_copied_and_missing_fails(self):
        repository = self.root / "repository"
        repository.mkdir()
        notices = self.root / "notices"
        notices.mkdir()
        required = ("LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.txt")
        for name in required:
            (repository / name).write_text(f"Required legal text: {name}\n")
        with patch.object(assembler, "REPO", repository):
            paths = assembler.copy_repository_notices(notices)
            self.assertEqual(paths, ["notices/Chudcode-" + name for name in required])
            for name in required:
                self.assertEqual(
                    (notices / ("Chudcode-" + name)).read_bytes(),
                    (repository / name).read_bytes(),
                )
                original = (repository / name).read_bytes()
                (repository / name).unlink()
                with self.assertRaisesRegex(ValueError, "Missing required"):
                    assembler.copy_repository_notices(notices)
                (repository / name).write_bytes(original)

    def test_macos_branding_preserves_electron_helper_lookup_and_payload(self):
        editor = self.root / "editor"
        contents = editor / "VSCodium.app" / "Contents"
        contents.mkdir(parents=True)
        info = {
            "CFBundleName": "VSCodium",
            "CFBundleDisplayName": "VSCodium",
            "CFBundleExecutable": "VSCodium",
            "CFBundleIdentifier": "com.vscodium",
            "CFBundleURLTypes": [
                {
                    "CFBundleURLName": "VSCodium",
                    "CFBundleURLSchemes": ["vscodium"],
                }
            ],
        }
        plist_path = contents / "Info.plist"
        plist_path.write_bytes(plistlib.dumps(info))
        main_executable = contents / "MacOS" / info["CFBundleExecutable"]
        main_executable.parent.mkdir()
        main_executable.write_bytes(b"unchanged main executable fixture")
        for suffix in ("", " (Renderer)", " (GPU)", " (Plugin)"):
            name = info["CFBundleName"] + " Helper" + suffix
            helper = contents / "Frameworks" / (name + ".app") / "Contents"
            (helper / "MacOS").mkdir(parents=True)
            (helper / "MacOS" / name).write_bytes(b"unchanged helper fixture")
            (helper / "Info.plist").write_bytes(
                plistlib.dumps(
                    {
                        "CFBundleName": name,
                        "CFBundleExecutable": name,
                        "CFBundleIdentifier": "com.vscodium.helper" + suffix,
                    }
                )
            )
            (helper / "_CodeSignature").mkdir()
            (helper / "_CodeSignature" / "CodeResources").write_bytes(
                b"unchanged upstream signature fixture"
            )
        app = contents / "Resources" / "app"
        app.mkdir(parents=True)
        assembler.dump_json(
            app / "product.json",
            {
                "nameShort": "VSCodium",
                "applicationName": "codium",
                "dataFolderName": ".vscode-oss",
                "sharedDataFolderName": ".vscode-oss-shared",
                "darwinBundleIdentifier": "com.vscodium",
            },
        )
        mutable = {
            "VSCodium.app/Contents/Info.plist",
            "VSCodium.app/Contents/Resources/app/product.json",
        }
        before = [
            entry
            for entry in assembler.file_inventory(editor)
            if entry["path"] not in mutable
        ]
        assembler.overlay_product(
            app,
            assembler.load_json(assembler.CONFIG / "product-overrides.json"),
            "0.4.3",
        )
        assembler.brand_macos(editor)
        branded = plistlib.loads(plist_path.read_bytes())
        self.assertEqual(branded["CFBundleName"], info["CFBundleName"])
        self.assertEqual(branded["CFBundleExecutable"], info["CFBundleExecutable"])
        self.assertEqual(branded["CFBundleDisplayName"], "Chudcode Workbench")
        self.assertEqual(
            branded["CFBundleIdentifier"], "dev.chudware.chudcode.workbench"
        )
        self.assertEqual(
            branded["CFBundleURLTypes"],
            [
                {
                    "CFBundleURLName": "Chudcode Workbench",
                    "CFBundleURLSchemes": ["chudcode-workbench"],
                }
            ],
        )
        # Electron resolves these paths from the main CFBundleName, including
        # when renderer/GPU/plugin helpers re-enter the native delegate.
        for suffix in ("", " (Renderer)", " (GPU)", " (Plugin)"):
            name = branded["CFBundleName"] + " Helper" + suffix
            helper = contents / "Frameworks" / (name + ".app") / "Contents"
            self.assertTrue((helper / "MacOS" / name).is_file())
        self.assertEqual(
            [
                entry
                for entry in assembler.file_inventory(editor)
                if entry["path"] not in mutable
            ],
            before,
        )
        product = assembler.load_json(app / "product.json")
        # VS Code overrides Electron's userData path using product.nameShort;
        # its extension/argv and shared-data roots use these separate identities.
        self.assertEqual(product["nameShort"], "Chudcode")
        self.assertEqual(product["applicationName"], "chudcode-workbench")
        self.assertEqual(product["dataFolderName"], ".chudcode-workbench")
        self.assertEqual(product["sharedDataFolderName"], ".chudcode-workbench-shared")
        self.assertEqual(
            product["darwinBundleIdentifier"], branded["CFBundleIdentifier"]
        )

    def test_atomic_publication_exposes_only_completed_candidate(self):
        staging = self.root / ".assembling"
        staging.mkdir()
        (staging / "VERSION").write_text("0.4.3\n")
        (staging / "candidate-manifest.json").write_text('{"complete":true}\n')
        (staging / "editor").mkdir()
        (staging / "editor" / "payload").write_bytes(b"complete payload")
        output = self.root / "candidate"
        self.assertFalse(output.exists())
        assembler.publish_directory(staging, output)
        self.assertFalse(staging.exists())
        self.assertEqual((output / "VERSION").read_text(), "0.4.3\n")
        self.assertTrue(
            json.loads((output / "candidate-manifest.json").read_text())["complete"]
        )
        self.assertEqual(
            (output / "editor" / "payload").read_bytes(), b"complete payload"
        )

    def test_atomic_publication_never_replaces_concurrent_output(self):
        for occupied in ("empty-directory", "nonempty-directory", "file", "symlink"):
            with self.subTest(occupied=occupied):
                staging = self.root / ("staging-" + occupied)
                staging.mkdir()
                (staging / "ours").write_text("candidate")
                output = self.root / ("output-" + occupied)
                if occupied.endswith("directory"):
                    output.mkdir()
                    if occupied == "nonempty-directory":
                        (output / "theirs").write_text("concurrent owner")
                elif occupied == "file":
                    output.write_text("concurrent owner")
                else:
                    try:
                        output.symlink_to(self.root / "missing")
                    except OSError:
                        continue  # Windows without symlink privilege still tests other paths.
                with self.assertRaises(OSError):
                    assembler.publish_directory(staging, output)
                self.assertEqual((staging / "ours").read_text(), "candidate")
                self.assertFalse((output / "ours").exists())
                if occupied == "nonempty-directory":
                    self.assertEqual(
                        (output / "theirs").read_text(), "concurrent owner"
                    )
                elif occupied == "file":
                    self.assertEqual(output.read_text(), "concurrent owner")
                elif occupied == "symlink":
                    self.assertTrue(output.is_symlink())

    def test_cross_host_identity_probes_fail_closed(self):
        with (
            patch.object(assembler.sys, "platform", "linux"),
            patch.object(assembler.platform, "machine", return_value="x86_64"),
        ):
            for target in ("darwin-x64", "win32-x64"):
                with self.assertRaisesRegex(ValueError, "requires a native"):
                    assembler.binary_evidence(
                        self.root / "absent", "chud", "0.4.3", target
                    )


class NativeConsumerTests(unittest.TestCase):
    def setUp(self):
        host = {"linux": "linux", "darwin": "darwin", "win32": "win32"}.get(
            sys.platform
        )
        if not host or platform.machine().lower() not in ("x86_64", "amd64"):
            self.skipTest("Requires a supported native x64 host")
        self.target = host + "-x64"
        self.version = assembler.load_json(assembler.CONFIG / "base.json")[
            "productVersion"
        ]

    def input(self, key):
        name = "CHUDCODE_ASSEMBLER_" + key.upper()
        value = os.environ.get(name)
        if not value:
            self.skipTest(f"Requires real compiled input: {name}")
        path = Path(value).resolve(strict=True)
        return path

    def test_real_compiled_roles_versions_and_digest_bound_evidence(self):
        for key, role in (
            ("launcher", "chudcode-desktop"),
            ("service", "chudcode-service"),
            ("chud", "chud"),
        ):
            path = self.input(key)
            with self.subTest(role=role):
                evidence = assembler.binary_evidence(
                    path, role, self.version, self.target
                )
                self.assertEqual(evidence["sha256"], assembler.digest(path))
                self.assertEqual(evidence["role"], role)
                with self.assertRaisesRegex(ValueError, "role/version mismatch"):
                    assembler.binary_evidence(path, role, "999.999.999", self.target)

    def test_service_cannot_be_relabelled_as_launcher(self):
        with self.assertRaisesRegex(ValueError, "role/version mismatch"):
            assembler.binary_evidence(
                self.input("service"), "chudcode-desktop", self.version, self.target
            )

    def test_actual_stale_compatibility_cli_rejected_before_output_exists(self):
        # This is the repository's pre-existing stale compiled consumer, not a header stub.
        path = assembler.REPO / "packages/coding-agent/binaries/chudcode-linux-x64"
        if self.target != "linux-x64" or not path.is_file():
            self.skipTest("Requires existing Linux compatibility binary")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "candidate"
            options = argparse.Namespace(
                target=self.target,
                output=str(output),
                chud=str(path),
                launcher=str(self.input("launcher")),
                service=str(self.input("service")),
                base_archive=str(path),  # Identity rejects before archive parsing.
                extension=str(assembler.REPO / "packages/chudcode-workbench"),
            )
            with self.assertRaisesRegex(
                ValueError, "chud executable role/version mismatch"
            ):
                assembler.assemble(options)
            self.assertFalse(output.exists())
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_complete_native_candidate_contains_notices_and_probe_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "candidate"
            options = argparse.Namespace(
                target=self.target,
                output=str(output),
                launcher=str(self.input("launcher")),
                service=str(self.input("service")),
                chud=str(self.input("chud")),
                base_archive=str(self.input("base_archive")),
                extension=str(assembler.REPO / "packages/chudcode-workbench"),
            )
            publish = assembler.publish_directory

            def publish_complete(staging, destination):
                self.assertFalse(destination.exists())
                self.assertTrue((staging / "candidate-manifest.json").is_file())
                staged_manifest = assembler.load_json(
                    staging / "candidate-manifest.json"
                )
                for entry in staged_manifest["files"]:
                    self.assertTrue(os.path.lexists(staging / entry["path"]))
                publish(staging, destination)

            with patch.object(
                assembler, "publish_directory", side_effect=publish_complete
            ) as publication:
                assembler.assemble(options)
                publication.assert_called_once()
            manifest = assembler.load_json(output / "candidate-manifest.json")
            for name in ("LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.txt"):
                self.assertEqual(
                    (output / "notices" / ("Chudcode-" + name)).read_bytes(),
                    (assembler.REPO / name).read_bytes(),
                )
            for key in ("launcher", "service", "chud"):
                path = output / manifest["layout"][key]
                self.assertEqual(
                    manifest["binaryEvidence"][key]["sha256"], assembler.digest(path)
                )
            if self.target == "darwin-x64":
                contents = output / "editor" / "VSCodium.app" / "Contents"
                info = plistlib.loads((contents / "Info.plist").read_bytes())
                self.assertEqual(info["CFBundleName"], "VSCodium")
                self.assertEqual(info["CFBundleExecutable"], "VSCodium")
                self.assertEqual(info["CFBundleDisplayName"], "Chudcode Workbench")
                self.assertEqual(
                    output / manifest["layout"]["editor"],
                    contents / "MacOS" / info["CFBundleExecutable"],
                )
                for suffix in ("", " (Renderer)", " (GPU)", " (Plugin)"):
                    name = info["CFBundleName"] + " Helper" + suffix
                    helper = contents / "Frameworks" / (name + ".app") / "Contents"
                    helper_info = plistlib.loads((helper / "Info.plist").read_bytes())
                    self.assertEqual(helper_info["CFBundleExecutable"], name)
                    executable = helper / "MacOS" / name
                    self.assertTrue(executable.is_file())
                    self.assertTrue(os.access(executable, os.X_OK))
                product = assembler.load_json(
                    contents / "Resources" / "app" / "product.json"
                )
                self.assertEqual(product["nameShort"], "Chudcode")
                self.assertEqual(product["dataFolderName"], ".chudcode-workbench")
                self.assertEqual(
                    product["sharedDataFolderName"], ".chudcode-workbench-shared"
                )
            with self.assertRaisesRegex(ValueError, "Refusing to overwrite"):
                assembler.assemble(options)
            raced_output = Path(directory) / "raced-candidate"
            options.output = str(raced_output)

            def concurrent_owner(staging, destination):
                destination.mkdir()
                (destination / "theirs").write_text("concurrent owner")
                publish(staging, destination)

            with (
                patch.object(
                    assembler, "publish_directory", side_effect=concurrent_owner
                ),
                self.assertRaises(OSError),
            ):
                assembler.assemble(options)
            self.assertEqual((raced_output / "theirs").read_text(), "concurrent owner")
            self.assertEqual(list(raced_output.iterdir()), [raced_output / "theirs"])
            self.assertFalse(list(Path(directory).glob(".*.assembling-*")))


if __name__ == "__main__":
    unittest.main()
