#!/usr/bin/python3
"""Root supervisor for the allowlisted, unprivileged HTTPS worker.

Launch only with python3 -I -S and a cleared environment. It starts no daemon,
creates no account and never reads application configuration or database keys.
"""
import argparse
import ctypes
import fcntl
import hashlib
import json
import os
import pathlib
import re
import resource
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse


class Refused(Exception):
    pass


def protected(path, mode=None):
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise Refused()
    for entry in (path, *path.parents):
        info = entry.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o7022:
            raise Refused()
    if mode is not None and stat.S_IMODE(path.stat().st_mode) != mode:
        raise Refused()
    return path


def regular(path, maximum, owner=0, mode=None, allow_setuid=False):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_nlink != 1 or info.st_size > maximum or info.st_mode & (0o3022 if allow_setuid else 0o7022) or 'security.capability' in os.listxattr(descriptor):
            raise Refused()
        if mode is not None and stat.S_IMODE(info.st_mode) != mode:
            raise Refused()
        return os.fdopen(descriptor, 'rb', closefd=True)
    except BaseException:
        os.close(descriptor)
        raise


def verified_bundle(installation):
    protected(installation, 0o700)
    bundle = protected(installation / 'bundle', 0o755)
    with regular(installation / 'bundle-manifest.json', 2 * 1024 * 1024, mode=0o600) as handle:
        value = json.load(handle)
    if not isinstance(value, dict) or set(value) != {'version', 'files'} or value['version'] != 1 or not isinstance(value['files'], list) or not 1 <= len(value['files']) <= 1000:
        raise Refused()
    expected = {}
    total = 0
    for entry in value['files']:
        if not isinstance(entry, dict) or set(entry) != {'path', 'mode', 'size', 'sha256'} or not isinstance(entry['path'], str):
            raise Refused()
        relative = pathlib.PurePosixPath(entry['path'])
        if relative.is_absolute() or str(relative) != entry['path'] or any(part in ('.', '..') for part in relative.parts) or '\\' in str(relative) or entry['path'] in expected:
            raise Refused()
        if type(entry['size']) is not int or not 0 <= entry['size'] <= 256 * 1024 * 1024 or entry['mode'] not in (0o400, 0o644, 0o755) or not re.fullmatch(r'[a-f0-9]{64}', str(entry['sha256'])):
            raise Refused()
        total += entry['size']
        if total > 512 * 1024 * 1024:
            raise Refused()
        expected[entry['path']] = entry
    actual = set()
    for path in bundle.rglob('*'):
        info = path.lstat()
        if path.is_symlink() or info.st_uid != 0 or info.st_mode & 0o7022:
            raise Refused()
        if stat.S_ISDIR(info.st_mode):
            continue
        relative = path.relative_to(bundle).as_posix()
        if relative not in expected:
            raise Refused()
        entry = expected[relative]
        with regular(path, 256 * 1024 * 1024) as handle:
            digest = hashlib.file_digest(handle, 'sha256').hexdigest()
        if info.st_size != entry['size'] or stat.S_IMODE(info.st_mode) != entry['mode'] or digest != entry['sha256']:
            raise Refused()
        actual.add(relative)
    if actual != set(expected):
        raise Refused()
    required = {'app/' + name for name in ('nativeWorkerClient.js', 'nativeWorkerClientConfig.js', 'nativeWorkerEntry.js', 'nativeWorkerExecutorClient.js', 'nativeWorkerLoop.js', 'package.json')}
    if not required.issubset(actual) or {name for name in actual if name.startswith('app/')} != required:
        raise Refused()
    for denied in ('home', 'mnt', 'root', 'runtime', 'app/config.js', 'app/.env', 'etc/shadow'):
        if (bundle / denied).exists():
            raise Refused()
    return bundle


def command(filename, allow_setuid=False):
    path = pathlib.Path(filename).resolve(strict=True)
    protected(path.parent)
    with regular(path, 256 * 1024 * 1024, allow_setuid=allow_setuid):
        pass
    if not os.access(path, os.X_OK):
        raise Refused()
    return str(path)


def run_fixed(arguments):
    subprocess.run(arguments, check=True, env={}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)


def terminate_namespace_child(wrapper):
    """Signal only PID 1, holding a pidfd against host PID reuse.

    Signalling unshare itself would trigger --kill-child=SIGKILL before the
    worker can await its lease/HTTP/executor shutdown barriers.
    """
    try:
        children = pathlib.Path(f'/proc/{wrapper.pid}/task/{wrapper.pid}/children').read_text().split()
        if len(children) != 1 or not children[0].isdigit():
            return False
        pid = int(children[0])
        descriptor = os.pidfd_open(pid)
        try:
            fields = pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
            if int(fields[1]) != wrapper.pid or wrapper.poll() is not None:
                return False
            signal.pidfd_send_signal(descriptor, signal.SIGTERM)
            return True
        finally:
            os.close(descriptor)
    except (OSError, ValueError, IndexError):
        return False


def namespace_init(installation, token, socket_directory, origin, worker_id, kinds):
    # These arguments originate only in this root supervisor. Validate again
    # before mounting; no user-controlled job input can reach this entry point.
    root = verified_bundle(installation)
    protected(token.parent, 0o700)
    protected(socket_directory, 0o750)
    if socket_directory.stat().st_gid != 10002 or token.name != 'token' or not token.parent.name.startswith('launch-') or token.parent.parent != installation / 'state':
        raise Refused()
    with regular(token, 130, owner=10002, mode=0o400):
        pass
    # The host /proc still describes the parent PID namespace until replaced.
    # NSpid must demonstrate that unshare actually created a child PID namespace.
    status = pathlib.Path('/proc/self/status').read_text()
    match = re.search(r'^NSpid:\s+(.+)$', status, re.M)
    if not match or len(match[1].split()) < 2 or match[1].split()[-1] != '1':
        raise Refused()
    mount = command('/usr/bin/mount', allow_setuid=True)
    run_fixed([mount, '--make-rprivate', '/'])
    run_fixed([mount, '--bind', str(root), str(root)])
    run_fixed([mount, '--bind', str(token), str(root / 'credentials/token')])
    run_fixed([mount, '-o', 'remount,bind,ro,nosuid,nodev,noexec', str(root / 'credentials/token')])
    run_fixed([mount, '--bind', str(socket_directory), str(root / 'run/executor')])
    run_fixed([mount, '-o', 'remount,bind,ro,nosuid,nodev,noexec', str(root / 'run/executor')])
    run_fixed([mount, '-t', 'proc', 'proc', str(root / 'proc'), '-o', 'ro,nosuid,nodev,noexec,hidepid=2'])
    run_fixed([mount, '-t', 'tmpfs', 'tmpfs', str(root / 'dev'), '-o', 'size=1m,nosuid,noexec,mode=0755'])
    for name, mode, minor in (('null', 0o666, 3), ('urandom', 0o444, 9)):
        path = root / 'dev' / name
        os.mknod(path, stat.S_IFCHR | mode, os.makedev(1, minor)); os.chmod(path, mode)
    run_fixed([mount, '-o', 'remount,bind,ro,nosuid,nodev', str(root)])
    os.chroot(root); os.chdir('/')
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    os.execve('/usr/bin/setpriv', ['setpriv', '--reuid=10002', '--regid=10002', '--clear-groups', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '--', '/usr/bin/node', '--use-openssl-ca', '--v8-pool-size=2', '--max-old-space-size=256', '/app/nativeWorkerEntry.js'], {
        'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C',
        'GROUNDWORK_WORKER_AUTHORITY_ORIGIN': origin, 'GROUNDWORK_WORKER_ID': worker_id,
        'GROUNDWORK_WORKER_KINDS': kinds, 'GROUNDWORK_WORKER_TOKEN_FILE': '/credentials/token',
        'GROUNDWORK_WORKER_EXECUTOR_SOCKET': '/run/executor/executor.sock',
    })


def main():
    # CPython can materialize LC_CTYPE while coercing a cleared C locale.
    # It is never inherited by the worker; every child gets a fixed env map.
    if sys.platform != 'linux' or os.geteuid() != 0 or any(name != 'LC_CTYPE' or value not in ('C.UTF-8', 'C.utf8') for name, value in os.environ.items()):
        raise Refused()
    os.umask(0o077)
    if len(sys.argv) == 8 and sys.argv[1] == '--namespace-init':
        namespace_init(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), pathlib.Path(sys.argv[4]), sys.argv[5], sys.argv[6], sys.argv[7])
        return
    parser = argparse.ArgumentParser(description='Run a sealed dedicated native network worker in the foreground')
    parser.add_argument('--installation', type=pathlib.Path, required=True)
    parser.add_argument('--token-file', type=pathlib.Path, required=True)
    parser.add_argument('--socket-directory', type=pathlib.Path, required=True)
    parser.add_argument('--authority-origin', required=True)
    parser.add_argument('--worker-id', required=True)
    parser.add_argument('--kinds', required=True)
    options = parser.parse_args()
    verified_bundle(options.installation)
    state = protected(options.installation / 'state', 0o700)
    protected(options.token_file.parent)
    protected(options.socket_directory, 0o750)
    if options.socket_directory.stat().st_gid != 10002:
        raise Refused()
    socket_info = (options.socket_directory / 'executor.sock').lstat()
    if not stat.S_ISSOCK(socket_info.st_mode) or socket_info.st_uid != 0 or socket_info.st_gid != 10002 or stat.S_IMODE(socket_info.st_mode) != 0o660 or socket_info.st_nlink != 1:
        raise Refused()
    parsed = urllib.parse.urlsplit(options.authority_origin)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment or not re.fullmatch(r'[A-Za-z0-9_-]{8,64}', options.worker_id):
        raise Refused()
    kinds = options.kinds.split(',')
    if not 1 <= len(kinds) <= 3 or len(set(kinds)) != len(kinds) or not set(kinds).issubset({'dwg-to-dxf', 'dxf-to-dwg', 'opensees-static'}):
        raise Refused()
    with regular(options.token_file, 130, mode=0o400) as handle:
        token = handle.read(131)
    if not re.fullmatch(rb'[A-Za-z0-9_-]{43,128}\n?', token):
        raise Refused()
    script = pathlib.Path(__file__).resolve(strict=True)
    protected(script.parent)
    with regular(script, 128 * 1024):
        pass
    python = command('/usr/bin/python3'); unshare = command('/usr/bin/unshare')
    lock = os.open(state / 'launcher.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    process = None; private = None
    try:
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            raise Refused()
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        private = pathlib.Path(tempfile.mkdtemp(prefix='launch-', dir=state)); os.chmod(private, 0o700)
        secret = private / 'token'
        descriptor = os.open(secret, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o400)
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(token); os.fchown(handle.fileno(), 10002, 10002)
        # A parent-death race is fenced before and after prctl. The unshare
        # wrapper kills PID 1; its PID namespace then kills all descendants.
        parent_pid = os.getpid()
        def before_exec():
            if os.getppid() != parent_pid or ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != parent_pid:
                os._exit(78)
        process = subprocess.Popen([unshare, '--mount', '--pid', '--ipc', '--uts', '--fork', '--kill-child=SIGKILL', python, '-I', '-S', str(script), '--namespace-init', str(options.installation), str(secret), str(options.socket_directory), options.authority_origin, options.worker_id, options.kinds], cwd='/', env={}, stdin=subprocess.DEVNULL, close_fds=True, start_new_session=True, preexec_fn=before_exec)
        stop_requested = False
        def stop(_signal, _frame):
            nonlocal stop_requested
            stop_requested = True
        signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)
        stop_deadline = None
        while process.poll() is None:
            if stop_requested and stop_deadline is None:
                stop_deadline = time.monotonic() + 15
                if not terminate_namespace_child(process):
                    os.killpg(process.pid, signal.SIGKILL)
            if stop_deadline is not None and time.monotonic() >= stop_deadline and process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
            time.sleep(.05)
        returncode = process.wait()
        if returncode:
            raise Refused()
    finally:
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL); process.wait(timeout=10)
        if private is not None and private.parent == state and private.name.startswith('launch-') and private.resolve(strict=True) == private:
            shutil.rmtree(private)
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Native network worker refused: sealed installation, private credentials and root confinement are required.', file=sys.stderr)
        sys.exit(78)
