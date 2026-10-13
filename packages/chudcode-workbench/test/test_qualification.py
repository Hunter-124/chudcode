"""Behavior regressions for private qualification subprocess ownership."""

import ctypes
import os
import signal
import subprocess
import sys
import tempfile
import unittest
from ctypes import wintypes
from pathlib import Path

from qualification import JsonProcess, SmokeError, kill_tree, run_process, spawn


class JsonProcessTests(unittest.TestCase):
    def test_background_invalid_json_fails_receive(self):
        with tempfile.TemporaryDirectory() as directory:
            process = JsonProcess(
                [sys.executable, "-c", "print('{invalid', flush=True)"],
                Path(directory),
                dict(os.environ),
                5,
            )
            try:
                with self.assertRaises(SmokeError):
                    process.receive(lambda _: True)
            finally:
                process.close()

    def test_background_invalid_utf8_fails_successful_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            process = JsonProcess(
                [
                    sys.executable,
                    "-c",
                    "import sys; sys.stdout.buffer.write(b'\\xff\\n')",
                ],
                Path(directory),
                dict(os.environ),
                5,
            )
            with self.assertRaisesRegex(SmokeError, "Invalid JSONL stdout"):
                process.close(require_success=True)


@unittest.skipUnless(os.name == "posix", "POSIX owner shutdown")
class PosixOwnershipTests(unittest.TestCase):
    def test_timeout_allows_owner_to_stop_separate_process_group(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            owned = spawn(
                [sys.executable, "-c", "import signal; signal.pause()"],
                root,
                dict(os.environ),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            owner_source = (
                "import os, signal, sys\n"
                "def close_owned(signum, frame):\n"
                "    os.kill(int(sys.argv[1]), signal.SIGTERM)\n"
                "    sys.exit(0)\n"
                "signal.signal(signal.SIGTERM, close_owned)\n"
                "signal.pause()\n"
            )
            try:
                with self.assertRaises(SmokeError):
                    run_process(
                        [sys.executable, "-c", owner_source, str(owned.pid)],
                        root,
                        dict(os.environ),
                        2,
                    )
                self.assertEqual(owned.wait(timeout=2), -signal.SIGTERM)
            finally:
                kill_tree(owned)


@unittest.skipUnless(os.name == "nt", "Windows Job Object lifecycle")
class WindowsOwnershipTests(unittest.TestCase):
    def test_job_kills_child_after_immediate_parent_exits(self):
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        open_process = kernel32.OpenProcess
        open_process.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        open_process.restype = wintypes.HANDLE
        wait_process = kernel32.WaitForSingleObject
        wait_process.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        wait_process.restype = wintypes.DWORD
        close_handle = kernel32.CloseHandle
        close_handle.argtypes = (wintypes.HANDLE,)
        close_handle.restype = wintypes.BOOL
        parent_source = (
            "import subprocess, sys; "
            "child = subprocess.Popen([sys.executable, '-c', "
            "'import time; time.sleep(120)'], "
            "stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); "
            "print(child.pid, flush=True); sys.stdin.read()"
        )
        with tempfile.TemporaryDirectory() as directory:
            parent = spawn(
                [sys.executable, "-c", parent_source],
                Path(directory),
                dict(os.environ),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                text=True,
            )
            child_handle = None
            try:
                child_pid = int(parent.stdout.readline())
                child_handle = open_process(0x00100000, False, child_pid)  # SYNCHRONIZE
                if not child_handle:
                    raise ctypes.WinError(ctypes.get_last_error())
                parent.stdin.close()
                self.assertEqual(parent.wait(timeout=5), 0)
                kill_tree(parent)
                self.assertEqual(wait_process(child_handle, 5000), 0)  # WAIT_OBJECT_0
            finally:
                kill_tree(parent)
                parent.stdout.close()
                if child_handle and not close_handle(child_handle):
                    raise ctypes.WinError(ctypes.get_last_error())


if __name__ == "__main__":
    unittest.main()
