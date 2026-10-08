"""Read only the explicitly supplied test process IDs; no system-wide inventory."""

import ctypes
import json
import os
import sys
from ctypes import wintypes


class Counters(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("faults", wintypes.DWORD)] + [
        (name, ctypes.c_size_t)
        for name in (
            "peak_working_set",
            "working_set",
            "peak_paged",
            "paged",
            "peak_nonpaged",
            "nonpaged",
            "pagefile",
            "peak_pagefile",
            "private_bytes",
        )
    ]


def process_memory(pid: int) -> dict:
    if sys.platform != "win32":
        raise RuntimeError("This T15 memory sampler requires Windows")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    psapi.GetProcessMemoryInfo.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(Counters),
        wintypes.DWORD,
    ]
    handle = kernel.OpenProcess(0x0400 | 0x0010, False, pid)
    if not handle:
        raise OSError("Test process exited or cannot be sampled")
    try:
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
            raise OSError("Cannot read test process memory")
        return {
            "private_bytes": counters.private_bytes,
            "working_set": counters.working_set,
            "peak_working_set": counters.peak_working_set,
        }
    finally:
        kernel.CloseHandle(handle)


if __name__ == "__main__":
    pids = [int(value) for value in sys.argv[1].split(",")] if len(sys.argv) > 1 else [os.getpid()]
    print(json.dumps([process_memory(pid) for pid in pids]))
