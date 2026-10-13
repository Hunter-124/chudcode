"""Shared stdlib-only process isolation for explicit candidate qualification."""

from __future__ import annotations

import json
import math
import os
import queue
import signal
import subprocess
import threading
import time
from collections.abc import Callable
from pathlib import Path

from windows_job import CREATE_SUSPENDED, WindowsJob


class SmokeError(RuntimeError):
    pass


def positive_timeout(value: str) -> float:
    result = float(value)
    if not math.isfinite(result) or result <= 0:
        raise ValueError("timeout must be finite and positive")
    return result


def install_cleanup_signals() -> None:
    def interrupt(_signum, _frame) -> None:
        raise KeyboardInterrupt(
            "Qualification interrupted; cleaning private subprocesses"
        )

    signal.signal(signal.SIGTERM, interrupt)


def isolated_environment(root: Path) -> dict[str, str]:
    # An allowlist, not a secret-name denylist: provider credentials and settings
    # overrides must never cross into a candidate run. X11 display access is
    # retained for a real graphical host (including xvfb-run).
    names = (
        "PATH",
        "SystemRoot",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "DISPLAY",
        "XAUTHORITY",
    )
    environment = {name: os.environ[name] for name in names if name in os.environ}
    native_variant = os.environ.get("PI_NATIVE_VARIANT")
    if native_variant is not None:
        if native_variant not in ("baseline", "modern"):
            raise SmokeError("PI_NATIVE_VARIANT must be baseline or modern")
        environment["PI_NATIVE_VARIANT"] = native_variant
    environment.update(
        {
            "HOME": str(root / "home"),
            "USERPROFILE": str(root / "home"),
            "APPDATA": str(root / "appdata"),
            "LOCALAPPDATA": str(root / "localappdata"),
            "XDG_CONFIG_HOME": str(root / "config"),
            "XDG_DATA_HOME": str(root / "data"),
            "XDG_CACHE_HOME": str(root / "cache"),
            "XDG_STATE_HOME": str(root / "state"),
            "XDG_RUNTIME_DIR": str(root / "runtime"),
            "TMPDIR": str(root / "tmp"),
            "TMP": str(root / "tmp"),
            "TEMP": str(root / "tmp"),
            "PI_NOTIFICATIONS": "off",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
    )
    for name in (
        "HOME",
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "XDG_RUNTIME_DIR",
        "TMPDIR",
    ):
        Path(environment[name]).mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != "nt":
        Path(environment["XDG_RUNTIME_DIR"]).chmod(0o700)
    return environment


def executable(path: Path) -> Path:
    try:
        resolved = path.resolve(strict=True)
    except OSError as error:
        raise SmokeError(f"Missing executable: {path}") from error
    if not resolved.is_file() or (os.name != "nt" and not os.access(resolved, os.X_OK)):
        raise SmokeError(f"Not an executable file: {resolved}")
    return resolved


def candidate_binary(binary: Path | None, bundle: Path | None) -> Path:
    if bundle is not None:
        binary = bundle / (
            "chudcode-desktop.exe" if os.name == "nt" else "chudcode-desktop"
        )
    if binary is None:
        raise SmokeError("Specify --binary or --bundle")
    return executable(binary)


class _OwnedProcess(subprocess.Popen):
    windows_job: WindowsJob | None = None


def spawn(
    command: list[str], cwd: Path, environment: dict[str, str], **kwargs
) -> _OwnedProcess:
    job = None
    process = None
    try:
        if os.name == "nt":
            job = WindowsJob()
            # No child code can run before assignment to our kill-on-close job.
            options = {"creationflags": CREATE_SUSPENDED}
        else:
            options = {"start_new_session": True}
        process = _OwnedProcess(command, cwd=cwd, env=environment, **options, **kwargs)
        process.windows_job = job
        if job is not None:
            job.assign_and_resume(process.pid)
        return process
    except BaseException as error:
        try:
            if process is not None:
                process.kill()
                process.wait(timeout=15)
                for stream in (process.stdin, process.stdout, process.stderr):
                    if stream is not None:
                        stream.close()
        finally:
            if job is not None:
                job.close()
        if isinstance(error, OSError):
            raise SmokeError(
                f"Cannot launch executable: {command[0]}: {error}"
            ) from error
        raise


def kill_tree(process: _OwnedProcess) -> None:
    # Ownership persists after the immediate parent exits: a Windows job or
    # POSIX process group must also kill remaining editor/service descendants.
    if os.name == "nt":
        if process.windows_job is None:
            raise SmokeError("Qualification process has no owned Windows job")
        process.windows_job.close()
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if process.poll() is None:
        process.kill()
    process.wait(timeout=15)


def run_process(
    command: list[str], cwd: Path, environment: dict[str, str], timeout: float
) -> str:
    # Files rather than PIPEs keep failed/native noisy startup from filling RAM.
    with (
        (cwd / "command-stdout.log").open("w+b") as stdout,
        (cwd / "command-stderr.log").open("w+b") as stderr,
    ):
        process = spawn(
            command,
            cwd,
            environment,
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
        )
        try:
            process.wait(timeout=timeout)
            stdout.seek(0)
            output = stdout.read(1024 * 1024 + 1)
            if len(output) > 1024 * 1024:
                raise SmokeError(f"Excessive command output: {command[0]}")
            if process.returncode != 0:
                stderr.seek(0)
                diagnostic = stderr.read(8192).decode("utf-8", errors="replace")
                standard_output = output[:8192].decode("utf-8", errors="replace")
                raise SmokeError(
                    f"Command failed ({process.returncode}): {command[0]} {command[1:]}; "
                    f"stderr: {diagnostic}; stdout: {standard_output}"
                )
            return output.decode("utf-8", errors="strict").strip()
        except subprocess.TimeoutExpired as error:
            raise SmokeError(
                f"Command timed out: {command[0]} {command[1:]}"
            ) from error
        finally:
            # Wrapper probes own their own process groups. Give their installed
            # SIGTERM handler a chance to clean those descendants before the
            # unconditional kill_tree; SIGKILL alone strands nested POSIX groups.
            if os.name != "nt" and process.poll() is None:
                try:
                    process.send_signal(signal.SIGTERM)
                    process.wait(timeout=15)
                except (ProcessLookupError, subprocess.TimeoutExpired):
                    pass
            kill_tree(process)


def check_candidate(
    binary: Path, cwd: Path, environment: dict[str, str], timeout: float
) -> dict:
    version_output = run_process([str(binary), "--version"], cwd, environment, timeout)
    raw = run_process([str(binary), "--check"], cwd, environment, timeout)
    try:
        check = json.loads(raw)
    except (ValueError, TypeError) as error:
        raise SmokeError("Launcher --check did not return JSON") from error
    if (
        not isinstance(check, dict)
        or not isinstance(check.get("version"), str)
        or not check["version"]
    ):
        raise SmokeError("Launcher --check omitted product version")
    if check["version"] != version_output:
        raise SmokeError("Launcher --version disagrees with --check")
    for name in (
        "root",
        "editor",
        "service",
        "chud",
        "extension",
        "userData",
        "extensions",
    ):
        value = check.get(name)
        if not isinstance(value, str) or not Path(value).is_absolute():
            raise SmokeError(f"Launcher --check omitted absolute {name} path")
    for name in ("editor", "service", "chud"):
        executable(Path(check[name]))
    extension = Path(check["extension"])
    manifest = extension / "package.json"
    if not manifest.is_file():
        raise SmokeError("Candidate built-in extension is missing package.json")
    package = json.loads(manifest.read_text(encoding="utf-8"))
    if (
        package.get("publisher") != "chudware"
        or package.get("name") != "chudcode-workbench"
    ):
        raise SmokeError("Candidate contains incompatible built-in extension")
    main = package.get("main")
    if not isinstance(main, str) or not (extension / main).is_file():
        raise SmokeError("Candidate built-in extension is not built")
    for name in ("userData", "extensions"):
        if not Path(check[name]).resolve().is_relative_to(cwd.resolve()):
            raise SmokeError(f"Launcher {name} escapes isolated smoke state")
    return check | {"versionOutput": version_output}


class JsonProcess:
    """Bounded JSONL reader that keeps draining through normal stdin EOF."""

    def __init__(
        self, command: list[str], cwd: Path, environment: dict[str, str], timeout: float
    ):
        self.timeout = timeout
        self.frames: queue.Queue[dict | Exception] = queue.Queue(maxsize=1024)
        self.failed = threading.Event()
        self.failure: Exception | None = None
        self.stderr = (cwd / "private-service-stderr.log").open("w+b")
        try:
            self.process = spawn(
                command,
                cwd,
                environment,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=self.stderr,
            )
        except BaseException:
            self.stderr.close()
            raise
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self) -> None:
        try:
            while True:
                line = self.process.stdout.readline(1024 * 1024 + 1)
                if not line:
                    break
                if len(line) > 1024 * 1024 or not line.endswith(b"\n"):
                    raise SmokeError("Invalid or excessive JSONL stdout frame")
                frame = json.loads(line.decode("utf-8", errors="strict"))
                if not isinstance(frame, dict):
                    raise SmokeError("JSONL frame is not an object")
                try:
                    self.frames.put_nowait(frame)
                except queue.Full as error:
                    raise SmokeError("JSONL frame queue overflow") from error
        except (SmokeError, OSError, ValueError) as error:
            self.failure = SmokeError(f"Invalid JSONL stdout: {type(error).__name__}")
            self.failed.set()
        finally:
            try:
                self.frames.put_nowait(
                    SmokeError("Executable stdout closed before expected response")
                )
            except queue.Full:
                pass

    def receive(self, predicate: Callable[[dict], bool]) -> dict:
        deadline = time.monotonic() + self.timeout
        while True:
            if self.failed.is_set():
                raise self.failure
            try:
                frame = self.frames.get(timeout=max(0, deadline - time.monotonic()))
            except queue.Empty as error:
                raise SmokeError(
                    "Timed out waiting for executable JSONL frame"
                ) from error
            if isinstance(frame, Exception):
                raise frame
            if predicate(frame):
                return frame

    def send(self, frame: dict) -> None:
        self.process.stdin.write((json.dumps(frame) + "\n").encode("utf-8"))
        self.process.stdin.flush()

    def close(
        self, require_success: bool = False, single_stdout_frame: bool = False
    ) -> None:
        try:
            if not self.process.stdin.closed:
                self.process.stdin.close()
            if require_success:
                try:
                    self.process.wait(timeout=self.timeout)
                except subprocess.TimeoutExpired as error:
                    raise SmokeError(
                        "Executable did not shut down after stdin EOF"
                    ) from error
                if self.process.returncode != 0:
                    raise SmokeError(
                        f"Executable EOF shutdown failed ({self.process.returncode})"
                    )
                if self.failed.is_set():
                    raise self.failure
                self.reader.join(timeout=5)
                if self.reader.is_alive():
                    raise SmokeError("Executable stdout did not close after exit")
                if self.failed.is_set():
                    raise self.failure
                if single_stdout_frame:
                    while not self.frames.empty():
                        if isinstance(self.frames.get_nowait(), dict):
                            raise SmokeError(
                                "Service emitted extra stdout after readiness"
                            )
        finally:
            kill_tree(self.process)
            self.reader.join(timeout=5)
            self.process.stdout.close()
            self.stderr.close()
