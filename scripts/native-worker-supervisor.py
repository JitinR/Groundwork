#!/usr/bin/python3
"""Prepare the fixed service socket and cgroup before running the sealed launchers."""

import os
import stat
import sys
import time
from pathlib import Path

SOCKET_DIRECTORY = Path("/run/groundwork-native")
SOCKET = SOCKET_DIRECTORY / "executor.sock"
EXECUTOR_UNIT = "/system.slice/groundwork-native-executor.service"
WORKER_UNIT = "/system.slice/groundwork-native-worker.service"


def protected(path, *, file=False):
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise ValueError("Expected canonical protected path")
    for item in (path, *path.parents):
        info = item.lstat()
        kind = stat.S_ISREG if file and item == path else stat.S_ISDIR
        if not kind(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o7022:
            raise ValueError("Unprotected installation path")
        if file and item == path and info.st_nlink != 1:
            raise ValueError("Linked launcher")
    return path


def enter_unit(expected):
    if Path("/proc/self/cgroup").read_text().strip() != f"0::{expected}":
        raise ValueError("Expected dedicated systemd unit")


def launch(script, arguments):
    os.execve("/usr/bin/python3", ["python3", "-I", "-S", str(protected(script, file=True)), *arguments], {})


def executor(installation):
    enter_unit(EXECUTOR_UNIT + "/supervisor")
    broker = protected(installation / "native-executor-broker.py", file=True)
    cgroup = protected(Path("/sys/fs/cgroup" + EXECUTOR_UNIT))
    protected(SOCKET_DIRECTORY)
    os.chown(SOCKET_DIRECTORY, 0, 10002)
    os.chmod(SOCKET_DIRECTORY, 0o750)
    (cgroup / "cgroup.subtree_control").write_text("+cpu +memory +pids\n")
    launch(broker, ["--bundle", str(installation / "bundle"),
                    "--manifest", str(installation / "bundle-manifest.json"),
                    "--state-root", str(installation / "state"),
                    "--socket", str(SOCKET), "--cgroup-root", str(cgroup)])


def worker(installation, origin, worker_id, kinds, token_file):
    enter_unit(WORKER_UNIT)
    launcher = protected(installation / "native-worker-launcher.py", file=True)
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        try:
            info = SOCKET.lstat()
        except FileNotFoundError:
            time.sleep(0.1)
            continue
        if stat.S_ISSOCK(info.st_mode) and info.st_uid == 0 and info.st_gid == 10002 and stat.S_IMODE(info.st_mode) == 0o660:
            launch(launcher, ["--installation", str(installation), "--token-file", token_file,
                              "--socket-directory", str(SOCKET_DIRECTORY), "--authority-origin", origin,
                              "--worker-id", worker_id, "--kinds", kinds])
        # The broker sets ownership and mode after binding the socket.
        time.sleep(0.1)
    raise ValueError("Executor socket readiness deadline exceeded")


def main():
    if os.geteuid() != 0:
        raise ValueError("Root systemd supervisor required")
    mode, directory, *arguments = sys.argv[1:]
    installation = protected(Path(directory))
    if mode == "executor" and not arguments:
        executor(installation)
    elif mode == "worker" and len(arguments) == 4:
        worker(installation, *arguments)
    else:
        raise ValueError("Unsupported service configuration")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError):
        print("Groundwork native service refused its startup configuration.", file=sys.stderr)
        sys.exit(78)
