#!/usr/bin/python3
"""Root-only, local native executor. This process has no queue/API credentials.

Install with stage-native-executor.sh and launch with a cleared environment,
Python -I -S, and a dedicated writable cgroup-v2 delegation. It never installs
a service, provisions a cgroup controller globally, or opens a TCP listener.
"""
import argparse
import base64
import ctypes
import fcntl
import hashlib
import json
import os
import pathlib
import re
import resource
import select
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import time
import uuid

MAX_FRAME = 48 * 1024 * 1024
MAX_BYTES = 32 * 1024 * 1024
JOB_SECONDS = 130
STOP = False
NAME = re.compile(r"^attempt-[a-f0-9]{32}$")
KINDS = {"dwg-to-dxf", "dxf-to-dwg", "opensees-static"}
CONTROL = {"memory.max": "536870912", "memory.swap.max": "0", "pids.max": "32", "cpu.max": "100000 100000"}


class Refused(Exception):
    pass


class CleanupFailed(Refused):
    pass


def exact(value, fields):
    return isinstance(value, dict) and set(value) == set(fields)


def regular(filename, private=False, maximum=256 * 1024 * 1024, allow_setuid=False):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
    descriptor = os.open(filename, flags)
    try:
        info = os.fstat(descriptor)
        forbidden_mode = 0o3022 if allow_setuid else 0o7022
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & forbidden_mode or info.st_size > maximum:
            raise Refused()
        if private and stat.S_IMODE(info.st_mode) != 0o600:
            raise Refused()
        if "security.capability" in os.listxattr(descriptor):
            raise Refused()
        return os.fdopen(descriptor, "rb", closefd=True)
    except BaseException:
        os.close(descriptor)
        raise


def protected_directory(filename, mode=None, gid=None):
    target = pathlib.Path(filename)
    if not target.is_absolute() or str(target.resolve(strict=True)) != str(target):
        raise Refused()
    for entry in (target, *target.parents):
        info = entry.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o7022:
            raise Refused()
    info = target.lstat()
    if mode is not None and stat.S_IMODE(info.st_mode) != mode:
        raise Refused()
    if gid is not None and info.st_gid != gid:
        raise Refused()
    return target


def no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Refused()
        result[key] = value
    return result


def parse_request(raw):
    # Valid requests have no arrays, at most two object levels, and ten keys.
    # Refuse structural expansion before allocating arbitrary Python objects.
    quoted = escaped = False
    depth = fields = 0
    for value in raw:
        if quoted:
            if escaped:
                escaped = False
            elif value == 92:
                escaped = True
            elif value == 34:
                quoted = False
        elif value == 34:
            quoted = True
        elif value in (91, 93):
            raise Refused()
        elif value == 123:
            depth += 1
            if depth > 2:
                raise Refused()
        elif value == 125:
            depth -= 1
        elif value == 58:
            fields += 1
            if fields > 12:
                raise Refused()
    payload = json.loads(raw.decode("utf-8", "strict"), object_pairs_hook=no_duplicate_keys)
    if exact(payload, ("version", "op")) and type(payload["version"]) is int and payload["version"] == 1 and payload["op"] == "probe":
        return payload
    if not exact(payload, ("version", "op", "jobId", "kind", "input")) or type(payload["version"]) is not int or payload["version"] != 1 or payload["op"] != "execute":
        raise Refused()
    source = payload["input"]
    if not isinstance(payload["jobId"], str) or not re.fullmatch(r"[a-f0-9]{32}", payload["jobId"]) or not isinstance(payload["kind"], str) or payload["kind"] not in KINDS or not exact(source, ("bytes", "sourceArtifactId", "sha256")):
        raise Refused()
    if not isinstance(source["sourceArtifactId"], str) or not re.fullmatch(r"[a-f0-9]{32}", source["sourceArtifactId"]) or not isinstance(source["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", source["sha256"]):
        raise Refused()
    if not isinstance(source["bytes"], str) or len(source["bytes"]) > ((MAX_BYTES + 2) // 3) * 4:
        raise Refused()
    binary = base64.b64decode(source["bytes"], validate=True)
    if not 0 < len(binary) <= MAX_BYTES or base64.b64encode(binary).decode("ascii") != source["bytes"] or hashlib.sha256(binary).hexdigest() != source["sha256"]:
        raise Refused()
    return payload


def send(connection, value):
    data = json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    if not 0 < len(data) <= MAX_FRAME:
        raise Refused()
    connection.settimeout(5)
    connection.sendall(struct.pack("!I", len(data)))
    connection.sendall(data)


def receive(connection, length, deadline):
    chunks = []
    received = 0
    while received < length:
        if STOP or time.monotonic() >= deadline:
            raise Refused()
        connection.settimeout(min(1, max(.01, deadline - time.monotonic())))
        try:
            value = connection.recv(min(1024 * 1024, length - received))
        except socket.timeout:
            continue
        if not value:
            raise Refused()
        received += len(value)
        chunks.append(value)
    return b"".join(chunks)


def manifest(bundle, filename):
    root = protected_directory(bundle)
    protected_directory(pathlib.Path(filename).parent)
    with regular(filename, private=True, maximum=2 * 1024 * 1024) as handle:
        value = json.load(handle, object_pairs_hook=no_duplicate_keys)
    if not exact(value, ("version", "files")) or value["version"] != 1 or not isinstance(value["files"], list) or not 1 <= len(value["files"]) <= 5000:
        raise Refused()
    entries = {}
    total = 0
    device = root.stat().st_dev
    for entry in value["files"]:
        if not exact(entry, ("path", "size", "mode", "sha256")) or not isinstance(entry["path"], str):
            raise Refused()
        relative = pathlib.PurePosixPath(entry["path"])
        if relative.is_absolute() or str(relative) != entry["path"] or any(part in (".", "..") for part in relative.parts) or "\\" in str(relative) or not relative.parts or entry["path"] in entries:
            raise Refused()
        if type(entry["size"]) is not int or not 0 <= entry["size"] <= 256 * 1024 * 1024 or type(entry["mode"]) is not int or entry["mode"] & ~0o755 or not re.fullmatch(r"[a-f0-9]{64}", str(entry["sha256"])):
            raise Refused()
        total += entry["size"]
        if total > 512 * 1024 * 1024:
            raise Refused()
        entries[entry["path"]] = entry
    actual = set()
    for target in root.rglob("*"):
        info = target.lstat()
        if info.st_dev != device or info.st_uid != 0 or info.st_mode & 0o7022 or target.is_symlink():
            raise Refused()
        if stat.S_ISDIR(info.st_mode):
            continue
        relative = str(target.relative_to(root))
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or relative not in entries:
            raise Refused()
        actual.add(relative)
        item = entries[relative]
        with regular(target) as handle:
            digest = hashlib.file_digest(handle, "sha256").hexdigest()
        if info.st_size != item["size"] or stat.S_IMODE(info.st_mode) != item["mode"] or digest != item["sha256"]:
            raise Refused()
    if actual != set(entries):
        raise Refused()
    for required in ("app/native-executor-job.mjs", "app/nativeAdapters.js", "app/engineeringBasis.js", "usr/bin/node", "usr/bin/prlimit", "usr/bin/setpriv", "runtime/bin/OpenSees", "runtime/bin/dwg2dxf", "runtime/bin/dxf2dwg"):
        if required not in entries:
            raise Refused()
    return root, entries


def copy_bundle(source, destination, entries):
    os.mkdir(destination, 0o755)
    os.chmod(destination, 0o755)
    for relative, info in entries.items():
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        with regular(source / relative) as input_file:
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, info["mode"])
            with os.fdopen(descriptor, "wb") as output_file:
                shutil.copyfileobj(input_file, output_file, 1024 * 1024)
        os.chmod(target, info["mode"])
        with regular(target) as output_file:
            if hashlib.file_digest(output_file, "sha256").hexdigest() != info["sha256"]:
                raise Refused()
    for name in ("jobs", "proc", "dev", "tmp"):
        (destination / name).mkdir(exist_ok=True, mode=0o755)
    # Creation runs with a private umask. The child must traverse the sealed
    # root after chroot/UID drop; private attempt contents stay below /jobs.
    for directory in (destination, *(entry for entry in destination.rglob("*") if entry.is_dir())):
        os.chmod(directory, 0o755)
    os.chmod(destination / "tmp", 0o700)
    for name, permissions, minor in (("null", 0o666, 3), ("urandom", 0o444, 9)):
        target = destination / "dev" / name
        os.mknod(target, stat.S_IFCHR | permissions, os.makedev(1, minor))
        os.chmod(target, permissions)


def write_private(filename, value):
    raw = json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    descriptor = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(raw)


def prepare_cgroup(root, name):
    protected_directory(root)
    if not {"cpu", "memory", "pids"}.issubset(set((root / "cgroup.subtree_control").read_text().split())):
        raise Refused()
    target = root / name
    target.mkdir(mode=0o700)
    try:
        for key, value in CONTROL.items():
            (target / key).write_text(value)
            if (target / key).read_text().strip() != value:
                raise Refused()
        if (target / "cgroup.procs").read_text().strip() or not (target / "cgroup.kill").exists():
            raise Refused()
        return target
    except BaseException:
        target.rmdir()
        raise


def end_cgroup(target, process=None):
    if not NAME.fullmatch(target.name):
        raise CleanupFailed()
    try:
        (target / "cgroup.kill").write_text("1")
    except FileNotFoundError:
        if process is not None and process.poll() is None:
            process.kill()
    if process is not None:
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired as error:
            raise CleanupFailed() from error
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if not target.exists():
            return
        events = dict(line.split() for line in (target / "cgroup.events").read_text().splitlines())
        if events.get("populated") == "0":
            target.rmdir()
            return
        time.sleep(.05)
    raise CleanupFailed()


def cleanup_attempt(root, target):
    if target.parent != root or not NAME.fullmatch(target.name) or target.resolve(strict=True) != target:
        raise CleanupFailed()
    info = target.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        raise CleanupFailed()
    # A root-owned attempt is inaccessible outside the broker; rmtree does not
    # follow symlink entries. Only called after the namespace/cgroup is empty.
    shutil.rmtree(target)


def trusted_command(filename, allow_setuid=False):
    target = pathlib.Path(filename).resolve(strict=True)
    protected_directory(target.parent)
    with regular(target, allow_setuid=allow_setuid):
        pass
    if not os.access(target, os.X_OK):
        raise Refused()
    return str(target)


def run_attempt(options, bundle, entries, payload, connection):
    name = "attempt-" + uuid.uuid4().hex
    directory = options.state_root / name
    directory.mkdir(mode=0o700)
    group = None
    process = None
    cleanup_safe = True
    try:
        group = prepare_cgroup(options.cgroup_root, name)
        rootfs = directory / "rootfs"
        copy_bundle(bundle, rootfs, entries)
        # The manifest cannot contain writable job/control paths.
        if any((rootfs / reserved).exists() for reserved in ("request.json", "result.json", "confinement.json")):
            raise Refused()
        write_private(rootfs / "request.json", payload)
        write_private(rootfs / "confinement.json", {
            "hostNamespaces": {kind: os.readlink("/proc/self/ns/" + kind) for kind in ("mnt", "net", "pid", "ipc", "uts")},
            "cgroup": {"name": name, "memoryMax": CONTROL["memory.max"], "pidsMax": CONTROL["pids.max"], "cpuMax": CONTROL["cpu.max"], "swapMax": CONTROL["memory.swap.max"]},
        })
        mode = payload["op"]
        broker_pid = os.getpid()
        def before_exec():
            # Parent death also kills unshare; its --kill-child kills PID 1,
            # and the private PID namespace kills even detached descendants.
            if os.getppid() != broker_pid or ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != broker_pid:
                os._exit(78)
            (group / "cgroup.procs").write_text(str(os.getpid()))
            resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
        process = subprocess.Popen([
            options.unshare, "--mount", "--net", "--pid", "--ipc", "--uts", "--fork", "--kill-child=SIGKILL",
            options.python, "-I", "-S", options.broker_script, "--namespace-init", str(rootfs), mode,
        ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={}, close_fds=True, start_new_session=True, preexec_fn=before_exec)
        deadline = time.monotonic() + JOB_SECONDS
        while process.poll() is None:
            if STOP or time.monotonic() > deadline:
                raise Refused()
            readable, _, _ = select.select([connection], [], [], .05)
            if readable:
                # No request data follows the one frame. EOF and extra bytes
                # both revoke this attempt immediately.
                connection.recv(1, socket.MSG_PEEK)
                raise Refused()
        if process.returncode != 0:
            raise Refused()
        with regular(rootfs / "result.json", private=True, maximum=MAX_FRAME) as handle:
            result = json.load(handle, object_pairs_hook=no_duplicate_keys)
        if mode == "probe":
            if result != {"version": 1, "ready": True}:
                raise Refused()
        elif not exact(result, ("version", "artifacts", "summary")) or result["version"] != 1:
            raise Refused()
        return result
    finally:
        if group is not None:
            try:
                end_cgroup(group, process)
            except BaseException:
                cleanup_safe = False
                raise CleanupFailed()
        elif process is not None:
            process.kill()
            process.wait(timeout=10)
        if cleanup_safe:
            cleanup_attempt(options.state_root, directory)


def namespace_init(rootfs, mode):
    if sys.platform != "linux" or os.geteuid() != 0 or mode not in ("probe", "execute"):
        raise Refused()
    root = protected_directory(rootfs)
    if root.name != "rootfs" or not NAME.fullmatch(root.parent.name):
        raise Refused()
    with regular(root / "confinement.json", private=True, maximum=4096) as handle:
        profile = json.load(handle, object_pairs_hook=no_duplicate_keys)
    # Refuse accidental direct invocation in the host namespaces BEFORE mount.
    if not exact(profile, ("hostNamespaces", "cgroup")) or not exact(profile["hostNamespaces"], ("mnt", "net", "pid", "ipc", "uts")):
        raise Refused()
    for kind, previous in profile["hostNamespaces"].items():
        if os.readlink("/proc/self/ns/" + kind) == previous:
            raise Refused()
    subprocess.run(["/usr/bin/mount", "--make-rprivate", "/"], check=True, env={}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
    subprocess.run(["/usr/bin/mount", "-t", "proc", "proc", str(root / "proc"), "-o", "nosuid,nodev,noexec,hidepid=2"], check=True, env={}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
    os.chroot(root)
    os.chdir("/")
    os.execve("/usr/bin/setpriv", ["setpriv", "--bounding-set=-all,+chown,+dac_override,+kill,+setgid,+setuid", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "--", "/usr/bin/node", "--v8-pool-size=2", "--max-old-space-size=256", "/app/native-executor-job.mjs", mode], {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"})


def stop(_number, _frame):
    global STOP
    STOP = True


def main():
    if sys.platform != "linux" or os.geteuid() != 0:
        raise Refused()
    os.umask(0o077)
    # Actual internal invocation is script --namespace-init ROOT MODE.
    if len(sys.argv) == 4 and sys.argv[1] == "--namespace-init":
        namespace_init(pathlib.Path(sys.argv[2]), sys.argv[3])
        return
    parser = argparse.ArgumentParser(description="Local isolated native executor; no network queue access")
    parser.add_argument("--bundle", type=pathlib.Path, required=True)
    parser.add_argument("--manifest", type=pathlib.Path, required=True)
    parser.add_argument("--state-root", type=pathlib.Path, required=True)
    parser.add_argument("--socket", type=pathlib.Path, required=True)
    parser.add_argument("--cgroup-root", type=pathlib.Path, required=True)
    parser.add_argument("--worker-uid", type=int, default=10002)
    parser.add_argument("--worker-gid", type=int, default=10002)
    options = parser.parse_args()
    if options.worker_uid <= 0 or options.worker_gid <= 0 or options.worker_uid == 10001 or options.worker_gid == 10001 or len(str(options.socket)) > 100 or not options.socket.is_absolute():
        raise Refused()
    for key, value in os.environ.items():
        if value and (re.search(r"(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASS|API_KEY|PRIVATE_KEY|ACCESS_KEY)(?:$|_)", key) or key in ("MASTER_KEY", "PREVIOUS_MASTER_KEY", "DATABASE_URL", "DATABASE_ADMIN_URL", "SUPABASE_DB_URL", "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH", "PYTHONHOME")):
            raise Refused()
    options.state_root = protected_directory(options.state_root, 0o700)
    options.cgroup_root = protected_directory(options.cgroup_root)
    protected_directory(options.socket.parent, 0o750, options.worker_gid)
    options.broker_script = str(pathlib.Path(__file__).resolve(strict=True))
    protected_directory(pathlib.Path(options.broker_script).parent)
    with regular(options.broker_script):
        pass
    options.python = trusted_command("/usr/bin/python3")
    options.unshare = trusted_command("/usr/bin/unshare")
    # Distribution mount helpers can carry setuid-root. This host-only helper
    # is invoked by an already-root broker before chroot, with fixed arguments;
    # it is never copied into the job bundle or made available to native code.
    trusted_command("/usr/bin/mount", allow_setuid=True)
    bundle, entries = manifest(options.bundle, options.manifest)
    lock_path = options.state_root / "broker.lock"
    lock = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            raise Refused()
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for target in options.cgroup_root.iterdir():
            if target.is_dir() and NAME.fullmatch(target.name):
                end_cgroup(target)
        for target in options.state_root.iterdir():
            if NAME.fullmatch(target.name):
                cleanup_attempt(options.state_root, target)
        if options.socket.exists() or options.socket.is_symlink():
            info = options.socket.lstat()
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0 or info.st_gid != options.worker_gid or info.st_nlink != 1:
                raise Refused()
            options.socket.unlink()
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            server.bind(str(options.socket))
            os.chown(options.socket, 0, options.worker_gid)
            os.chmod(options.socket, 0o660)
            server.listen(1)
            server.settimeout(.5)
            signal.signal(signal.SIGTERM, stop)
            signal.signal(signal.SIGINT, stop)
            while not STOP:
                try:
                    connection, _ = server.accept()
                except socket.timeout:
                    continue
                with connection:
                    fatal = False
                    try:
                        _pid, uid, _gid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
                        if uid != options.worker_uid:
                            raise Refused()
                        deadline = time.monotonic() + 10
                        length = struct.unpack("!I", receive(connection, 4, deadline))[0]
                        if not 0 < length <= MAX_FRAME:
                            raise Refused()
                        payload = parse_request(receive(connection, length, deadline))
                        result = run_attempt(options, bundle, entries, payload, connection)
                        send(connection, result)
                    except CleanupFailed:
                        fatal = True
                    except (Refused, ValueError, TypeError, UnicodeError, OSError, subprocess.SubprocessError):
                        try:
                            send(connection, {"version": 1, "error": "EXECUTION_FAILED"})
                        except (OSError, Refused):
                            pass
                    if fatal:
                        raise CleanupFailed()
        finally:
            server.close()
            if options.socket.exists() and stat.S_ISSOCK(options.socket.lstat().st_mode) and options.socket.lstat().st_uid == 0:
                options.socket.unlink()
    finally:
        os.close(lock)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Native executor unavailable; protected runtime, cgroup delegation and confinement are required.", file=sys.stderr)
        sys.exit(78)
