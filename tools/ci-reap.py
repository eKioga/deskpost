#!/usr/bin/env python3
"""Run CI as a subreaper, then drain or kill only our adopted children."""
import argparse
import ctypes
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

DRAIN_SECONDS = 60
KILL_SECONDS = 5


def children():
    found = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            if int(fields[1]) == os.getpid():
                command = (entry / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace').strip()
                found.append((int(entry.name), command))
        except (FileNotFoundError, ProcessLookupError):
            pass
    return found


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--drain-seconds', type=float, default=DRAIN_SECONDS)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if not 0 < args.drain_seconds <= DRAIN_SECONDS:
        parser.error('drain seconds must be positive and at most 60')
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'PR_SET_CHILD_SUBREAPER')
    command = args.command or ['node', 'test/run-parallel.ts', '--workers', '6', '--keep-logs']
    if command[0] == '--':
        command = command[1:]
    child = subprocess.Popen(command)
    # Reap adopted zombies while the runner is alive too (section 430 needs this).
    while True:
        pid, status = os.waitpid(-1, 0)
        if pid == child.pid:
            result = os.waitstatus_to_exitcode(status)
            child.returncode = result
            break
    deadline = time.monotonic() + args.drain_seconds
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return result if result >= 0 else 128 - result
        if time.monotonic() >= deadline:
            break
        if pid:
            continue
        time.sleep(0.05)
    # A child can fork during cleanup; rescan without introducing another unbounded wait.
    kill_deadline = time.monotonic() + KILL_SECONDS
    reported = set()
    while True:
        for pid, command in children():
            if pid not in reported:
                print(f'orphans outlived the runner: {pid} {command}', flush=True)
                reported.add(pid)
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return 1
        if time.monotonic() >= kill_deadline:
            print('orphan reap deadline reached', flush=True)
            return 1
        if not pid:
            time.sleep(0.05)


if __name__ == '__main__':
    sys.exit(main())
