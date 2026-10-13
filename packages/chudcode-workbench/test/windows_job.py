"""Windows qualification process ownership using kill-on-close Job Objects.

Call assign_and_resume only on a process created with CREATE_SUSPENDED. The
primary thread stays suspended until job assignment succeeds, so no child can
escape qualification ownership during launch.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes

CREATE_SUSPENDED = 0x00000004


class _BasicLimits(ctypes.Structure):
    _fields_ = (
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    )


class _IoCounters(ctypes.Structure):
    _fields_ = tuple(
        (name, ctypes.c_ulonglong)
        for name in (
            "ReadOperationCount",
            "WriteOperationCount",
            "OtherOperationCount",
            "ReadTransferCount",
            "WriteTransferCount",
            "OtherTransferCount",
        )
    )


class _ExtendedLimits(ctypes.Structure):
    _fields_ = (
        ("BasicLimitInformation", _BasicLimits),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    )


class _ThreadEntry(ctypes.Structure):
    _fields_ = (
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ThreadID", wintypes.DWORD),
        ("th32OwnerProcessID", wintypes.DWORD),
        ("tpBasePri", wintypes.LONG),
        ("tpDeltaPri", wintypes.LONG),
        ("dwFlags", wintypes.DWORD),
    )


def _function(library, name, result, arguments):
    function = getattr(library, name)
    function.restype = result
    function.argtypes = arguments
    return function


class WindowsJob:
    def __init__(self) -> None:
        library = ctypes.WinDLL("kernel32", use_last_error=True)
        self._close_handle = _function(
            library, "CloseHandle", wintypes.BOOL, (wintypes.HANDLE,)
        )
        create_job = _function(
            library,
            "CreateJobObjectW",
            wintypes.HANDLE,
            (ctypes.c_void_p, wintypes.LPCWSTR),
        )
        set_limits = _function(
            library,
            "SetInformationJobObject",
            wintypes.BOOL,
            (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD),
        )
        self._open_process = _function(
            library,
            "OpenProcess",
            wintypes.HANDLE,
            (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD),
        )
        self._assign = _function(
            library,
            "AssignProcessToJobObject",
            wintypes.BOOL,
            (wintypes.HANDLE, wintypes.HANDLE),
        )
        self._snapshot = _function(
            library,
            "CreateToolhelp32Snapshot",
            wintypes.HANDLE,
            (wintypes.DWORD, wintypes.DWORD),
        )
        self._thread_first = _function(
            library,
            "Thread32First",
            wintypes.BOOL,
            (wintypes.HANDLE, ctypes.POINTER(_ThreadEntry)),
        )
        self._thread_next = _function(
            library,
            "Thread32Next",
            wintypes.BOOL,
            (wintypes.HANDLE, ctypes.POINTER(_ThreadEntry)),
        )
        self._open_thread = _function(
            library,
            "OpenThread",
            wintypes.HANDLE,
            (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD),
        )
        self._resume = _function(
            library, "ResumeThread", wintypes.DWORD, (wintypes.HANDLE,)
        )
        self.handle = create_job(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            limits = _ExtendedLimits()
            limits.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE
            if not set_limits(
                self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)
            ):
                raise ctypes.WinError(ctypes.get_last_error())
        except BaseException:
            self.close()
            raise

    def _close(self, handle) -> None:
        if not self._close_handle(handle):
            raise ctypes.WinError(ctypes.get_last_error())

    def _primary_thread(self, pid: int) -> int:
        snapshot = self._snapshot(0x00000004, 0)  # TH32CS_SNAPTHREAD
        if snapshot == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            entry = _ThreadEntry()
            entry.dwSize = ctypes.sizeof(entry)
            present = self._thread_first(snapshot, ctypes.byref(entry))
            threads = []
            while present:
                if entry.th32OwnerProcessID == pid:
                    threads.append(entry.th32ThreadID)
                entry.dwSize = ctypes.sizeof(entry)
                present = self._thread_next(snapshot, ctypes.byref(entry))
            error = ctypes.get_last_error()
            if error != 18:  # ERROR_NO_MORE_FILES
                raise ctypes.WinError(error)
            if len(threads) != 1:
                raise OSError(
                    "Suspended qualification process has no unique primary thread"
                )
            return threads[0]
        finally:
            self._close(snapshot)

    def assign_and_resume(self, pid: int) -> None:
        process = self._open_process(
            0x0100 | 0x0001, False, pid
        )  # SET_QUOTA | TERMINATE
        if not process:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            if not self._assign(self.handle, process):
                raise ctypes.WinError(ctypes.get_last_error())
            thread = self._open_thread(0x0002, False, self._primary_thread(pid))
            if not thread:
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                previous = self._resume(thread)
                if previous == 0xFFFFFFFF:
                    raise ctypes.WinError(ctypes.get_last_error())
                if previous != 1:
                    raise OSError(
                        "Qualification primary thread was not suspended exactly once"
                    )
            finally:
                self._close(thread)
        finally:
            self._close(process)

    def close(self) -> None:
        if self.handle is not None:
            self._close(self.handle)
            self.handle = None
