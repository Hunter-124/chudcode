#!/usr/bin/env python3
"""Run real Code-OSS extension-host integration against an assembled candidate.

python3 packages/chudcode-workbench/test/run_extension_host.py --bundle /candidate
On headless Linux invoke this command through xvfb-run -a; a missing display,
executable, built extension, or service is a failure, never a skipped test.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True
from qualification import (
    SmokeError,
    candidate_binary,
    check_candidate,
    install_cleanup_signals,
    isolated_environment,
    positive_timeout,
    run_process,
)


def main() -> int:
    install_cleanup_signals()
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--binary",
        type=Path,
        help="Rust candidate launcher, not a stock editor executable",
    )
    source.add_argument("--bundle", type=Path, help="Assembled candidate directory")
    parser.add_argument(
        "--timeout",
        type=positive_timeout,
        default=180.0,
        help="Host lifecycle safety timeout in seconds, not a performance budget",
    )
    arguments = parser.parse_args()
    try:
        binary = candidate_binary(arguments.binary, arguments.bundle)
        tests = Path(__file__).resolve().parent / "index.cjs"
        if not tests.is_file():
            raise SmokeError("Real extension-host suite is missing index.cjs")
        with tempfile.TemporaryDirectory(
            prefix="chudcode-extension-host-"
        ) as directory:
            root = Path(directory).resolve()
            environment = isolated_environment(root)
            check = check_candidate(binary, root, environment, arguments.timeout)
            workspace = root / "workspace"
            workspace.mkdir()
            (workspace / "qualification.txt").write_text(
                "Real isolated Code-OSS workspace\n", encoding="utf-8"
            )
            (root / "outside.txt").write_text(
                "Outside workspace sentinel\n", encoding="utf-8"
            )
            user_data = root / "user-data"
            extensions = root / "extensions"
            user_settings = user_data / "User"
            user_settings.mkdir(parents=True)
            extensions.mkdir()
            (user_settings / "settings.json").write_text(
                json.dumps(
                    {
                        "telemetry.telemetryLevel": "off",
                        "update.mode": "none",
                        "extensions.autoCheckUpdates": False,
                        "extensions.autoUpdate": False,
                        "workbench.startupEditor": "none",
                        "workbench.enableExperiments": False,
                        "git.enabled": False,
                    }
                ),
                encoding="utf-8",
            )
            evidence_path = root / "evidence.json"
            environment.update(
                {
                    "CHUDCODE_QUALIFICATION_EVIDENCE": str(evidence_path),
                    "CHUDCODE_QUALIFICATION_ROOT": str(root),
                    # Exercise the native launcher's inherited-runtime cleanup.
                    "BUN_BE_BUN": "1",
                }
            )
            run_process(
                [
                    str(binary),
                    "--new-window",
                    "--wait",
                    "--disable-workspace-trust",
                    "--skip-welcome",
                    "--skip-release-notes",
                    "--user-data-dir",
                    str(user_data),
                    "--extensions-dir",
                    str(extensions),
                    f"--extensionDevelopmentPath={check['extension']}",
                    f"--extensionTestsPath={tests}",
                    str(workspace),
                ],
                root,
                environment,
                arguments.timeout,
            )
            if not evidence_path.is_file():
                raise SmokeError(
                    "Editor exited without executing the real extension-host suite"
                )
            evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
            if (
                not isinstance(evidence, dict)
                or evidence.get("qualification") != "real-code-oss-extension-host-only"
                or evidence.get("stable_ready") is not False
                or not isinstance(evidence.get("checks"), list)
                or len(evidence["checks"]) < 7
            ):
                raise SmokeError(
                    "Extension host returned incomplete qualification evidence"
                )
            evidence.update(
                {
                    "version": check["version"],
                    "target": check.get("target"),
                    "editor_exit": 0,
                    "unqualified_gates": [
                        "interactive webview/UI capture",
                        "native terminal interaction",
                        "CAD downstream smoke",
                        "macOS/Windows execution and signing",
                        "live provider/OAuth",
                        "CloudCastle deployed integration",
                    ],
                }
            )
            print(json.dumps(evidence, sort_keys=True))
        return 0
    except (
        SmokeError,
        OSError,
        ValueError,
        subprocess.SubprocessError,
        KeyboardInterrupt,
    ) as error:
        print(
            f"Extension-host integration FAILED: {type(error).__name__}: {error}",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
