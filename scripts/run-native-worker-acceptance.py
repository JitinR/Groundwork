#!/usr/bin/python3
"""Synthetic real-executor acceptance on a delegated x86_64 Linux host.

No production authority, queue token, project data, account or daemon is used.
The parent cgroup must already delegate cpu, memory and pids. This program
enables controllers only in its newly created, invocation-specific child.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid


CONTROLLERS = {"cpu", "memory", "pids"}
MODULES = (
    "nativeAdapters.js", "engineeringBasis.js", "nativeWorkerClient.js",
    "nativeWorkerClientConfig.js", "nativeWorkerEntry.js",
    "nativeWorkerExecutorClient.js", "nativeWorkerLoop.js",
)
SCRIPTS = (
    "stage-native-executor.sh", "native-executor-broker.py",
    "native-executor-job.mjs", "native-executor-probe.mjs",
    "stage-native-worker.sh", "native-worker-launcher.py",
)
ATTEMPT = re.compile(r"^attempt-[a-f0-9]{32}$")


class AcceptanceError(RuntimeError):
    pass


def require(value, message):
    if not value:
        raise AcceptanceError(message)


def protected_directory(filename):
    path = pathlib.Path(filename)
    require(path.is_absolute() and path.resolve(strict=True) == path,
            "Canonical protected Linux paths are required")
    for target in (path, *path.parents):
        info = target.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
                info.st_mode & 0o7022 == 0, f"Native acceptance directory is not protected: {target}")
    return path


def wait_until(check, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(.01)
    raise AcceptanceError("Acceptance condition exceeded its bounded wait")


def digest(filename):
    with open(filename, "rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def stage_source(repo, root):
    mirror = pathlib.Path(tempfile.mkdtemp(prefix="source-", dir=root))
    os.chmod(mirror, 0o755)
    hashes = {}

    def copy(relative):
        source, target = repo / relative, mirror / relative
        descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        with os.fdopen(descriptor, "rb") as incoming:
            info = os.fstat(incoming.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
                    info.st_size <= 64 * 1024 * 1024, "Unexpected acceptance source file")
            target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            with open(target, "xb") as outgoing:
                shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
        os.chmod(target, 0o644)
        hashes[str(relative)] = digest(target)

    for name in MODULES:
        copy(pathlib.Path("server/dist") / name)
    for name in SCRIPTS:
        copy(pathlib.Path("scripts") / name)
    package = repo / "node_modules/zod"
    require(package.is_dir() and not package.is_symlink(), "Install the locked Zod package before acceptance")
    for item in package.rglob("*"):
        require(not item.is_symlink(), "Linked package entries are refused")
        if item.is_file():
            copy(item.relative_to(repo))
        else:
            require(item.is_dir(), "Special package entries are refused")
    for name in ("source.dxf", "source.json"):
        copy(pathlib.Path("artifacts/native-acceptance") / name)
    for directory in (mirror, *(item for item in mirror.rglob("*") if item.is_dir())):
        os.chmod(directory, 0o755)
    return mirror, hashes


def write_report(directory, value):
    created = not directory.exists()
    directory.mkdir(parents=True, exist_ok=True)
    require(directory.resolve(strict=True) == directory and not directory.is_symlink(),
            "Evidence directory must be canonical")
    if created:
        os.chmod(directory, 0o755)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=directory, prefix=".report-", encoding="utf8", delete=False) as handle:
            temporary = pathlib.Path(handle.name)
            json.dump(value, handle, indent=2)
            handle.write("\n")
            os.fchmod(handle.fileno(), 0o644)
        temporary.replace(directory / "report.json")
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def terminate(process, seconds=15):
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=seconds)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def local_authority_flow(repo, root, mirror, node, socketdir, authority_uid, authority_gid):
    """Exercise the shipped launcher against the real API on local HTTPS."""
    worker_install = root / ("groundwork-native-worker-" + mirror.name[7:])
    with tempfile.TemporaryDirectory(prefix="tls-flow-", dir=root) as temporary:
        flow = pathlib.Path(temporary)
        os.chmod(flow, 0o755)
        credentials, authority_data = flow / "credentials", flow / "authority"
        credentials.mkdir(mode=0o700)
        authority_data.mkdir(mode=0o700)
        token = secrets.token_urlsafe(32).encode("ascii")
        token_file = credentials / "token"
        token_file.write_bytes(token + b"\n")
        os.chmod(token_file, 0o400)
        fingerprint = hashlib.sha256(token).hexdigest()
        del token
        cert, key = authority_data / "certificate.pem", authority_data / "key.pem"
        subprocess.run(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-noenc", "-days", "1",
                        "-subj", "/CN=Groundwork synthetic authority", "-addext", "subjectAltName=IP:127.0.0.1",
                        "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", str(key), "-out", str(cert)],
                       check=True, cwd="/", env={}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, close_fds=True)
        ca = credentials / "test-ca.pem"
        ca.write_bytes(pathlib.Path("/etc/ssl/certs/ca-certificates.crt").read_bytes() + b"\n" + cert.read_bytes())
        resolver = credentials / "resolver.conf"
        resolver.write_text("nameserver 127.0.0.1\n")
        for item in (authority_data, cert, key):
            os.chown(item, authority_uid, authority_gid)
        subprocess.run(["/usr/bin/bash", str(mirror / "scripts/stage-native-worker.sh"), str(worker_install)],
                       check=True, cwd="/", env={"GROUNDWORK_NATIVE_NODE_PATH": str(node), "GROUNDWORK_NATIVE_CA_BUNDLE": str(ca),
                                                "GROUNDWORK_NATIVE_RESOLVER_FILE": str(resolver)},
                       stdin=subprocess.DEVNULL, close_fds=True)
        state = authority_data / "state.json"

        def read_state():
            try:
                return json.loads(state.read_text())
            except (FileNotFoundError, ValueError):
                return {}

        authority, worker = None, None
        with open(flow / "authority.log", "w+b") as authority_log, open(flow / "worker.log", "w+b") as worker_log:
            try:
                authority = subprocess.Popen(["/usr/bin/setpriv", f"--reuid={authority_uid}", f"--regid={authority_gid}", "--clear-groups",
                    "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "--", str(node),
                    str(repo / "scripts/native-worker-authority-acceptance.mjs"), str(cert), str(key), str(authority_data), str(state),
                    fingerprint, str(mirror / "artifacts/native-acceptance/source.dxf")], cwd="/", env={}, stdin=subprocess.DEVNULL,
                    stdout=authority_log, stderr=subprocess.STDOUT, close_fds=True)
                # Windows-mounted WSL checkouts can take tens of seconds to
                # load the real app and its dependencies on a cold start.
                wait_until(lambda: read_state().get("phase") or authority.poll() is not None, 75)
                ready = read_state()
                require(ready.get("phase") == "ready" and re.fullmatch(r"https://127\.0\.0\.1:[0-9]{1,5}", ready.get("origin", "")),
                        "Synthetic HTTPS authority did not accept the initial submission")
                worker = subprocess.Popen(["/usr/bin/python3", "-I", "-S", str(worker_install / "native-worker-launcher.py"),
                    "--installation", str(worker_install), "--token-file", str(token_file), "--socket-directory", str(socketdir),
                    "--authority-origin", ready["origin"], "--worker-id", "acceptance-worker", "--kinds", "dxf-to-dwg,dwg-to-dxf,opensees-static"],
                    cwd="/", env={}, stdin=subprocess.DEVNULL, stdout=worker_log, stderr=subprocess.STDOUT, close_fds=True)
                wait_until(lambda: read_state().get("phase") in ("accepted", "failed") or authority.poll() is not None or worker.poll() is not None, 150)
                result = read_state()
                require(result.get("phase") == "accepted" and worker.poll() is None and authority.poll() is None,
                        "Sealed worker did not complete the local HTTPS job flow")
                terminate(worker, 18)
                terminate(authority)
                worker_log.seek(0)
                messages = worker_log.read(64 * 1024).decode("utf8", errors="replace").splitlines()
                require(worker.returncode == 0 and authority.returncode == 0 and
                        messages.count("[groundwork-native-worker] job_succeeded") == 3 and
                        "[groundwork-native-worker] stopped" in messages,
                        "Worker or authority did not shut down cleanly after three acknowledged jobs")
                require(not any(path.name.startswith("launch-") for path in (worker_install / "state").iterdir()),
                        "Private launch credential copy was not removed")
                require(all(check["passed"] is True for check in result["checks"]), "HTTPS acceptance reported a failed check")
                return {"checks": result["checks"] + [{"name": "sealed-worker-clean-stop-and-private-credential-cleanup", "passed": True}],
                        "workerBundleManifestSha256": digest(worker_install / "bundle-manifest.json"),
                        "authorityFixtureSha256": digest(repo / "scripts/native-worker-authority-acceptance.mjs")}
            except BaseException:
                # Only fixed client codes and synthetic API status counts cross this boundary.
                worker_log.seek(0)
                allowed = re.compile(r"^\[groundwork-native-worker\] [a-z_]{1,40}$")
                print("Synthetic worker diagnostics: " + ", ".join(line for line in worker_log.read(65536).decode("utf8", errors="replace").splitlines() if allowed.fullmatch(line)), file=sys.stderr)
                authority_log.seek(0)
                statuses = {}
                for line in authority_log.read(512 * 1024).splitlines():
                    try:
                        value = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(value, dict) and value.get("type") == "api.request" and type(value.get("status")) is int:
                        statuses[value["status"]] = statuses.get(value["status"], 0) + 1
                print("Synthetic authority status counts: " + json.dumps(statuses), file=sys.stderr)
                raise
            finally:
                terminate(worker, 18)
                terminate(authority)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent.parent)
    parser.add_argument("--runtime", type=pathlib.Path, default=pathlib.Path("/opt/groundwork-native-acceptance/runtime"))
    parser.add_argument("--tcl-library", type=pathlib.Path, default=pathlib.Path("/usr/share/tcltk/tcl8.6"))
    parser.add_argument("--acceptance-root", type=pathlib.Path, default=pathlib.Path("/opt/groundwork-native-worker-acceptance"))
    parser.add_argument("--cgroup-parent", type=pathlib.Path, default=pathlib.Path("/sys/fs/cgroup"))
    parser.add_argument("--node", type=pathlib.Path, default=pathlib.Path(os.environ.get("GROUNDWORK_NATIVE_NODE_PATH", "/usr/bin/node")))
    parser.add_argument("--with-authority", action="store_true", help="also exercise the sealed worker and real HTTPS API on synthetic local data")
    parser.add_argument("--authority-uid", type=int, default=10003, help="unprivileged identity for the synthetic API fixture")
    parser.add_argument("--authority-gid", type=int, default=10003, help="unprivileged group for the synthetic API fixture")
    options = parser.parse_args()
    require(sys.platform == "linux" and os.geteuid() == 0 and os.uname().machine == "x86_64",
            "Acceptance requires root on x86_64 Linux")
    require(all(0 < value < 2**31 and value not in (10001, 10002) for value in (options.authority_uid, options.authority_gid)),
            "Synthetic API fixture requires a distinct unprivileged UID and GID")
    os.umask(0o077)
    repo = options.repo.resolve(strict=True)
    output = repo / "artifacts/native-worker-acceptance"
    write_report(output, {"version": 1, "status": "incomplete", "productionReady": False,
                          "liveAuthorityConnected": False})
    parent = protected_directory(options.cgroup_parent)
    require(CONTROLLERS.issubset(set((parent / "cgroup.subtree_control").read_text().split())),
            "Parent cgroup must already delegate cpu, memory and pids; no global controller changes are made")
    runtime = protected_directory(options.runtime)
    tcl_library = protected_directory(options.tcl_library)
    node = options.node.resolve(strict=True)
    node_info = node.lstat()
    protected_directory(node.parent)
    require(stat.S_ISREG(node_info.st_mode) and node_info.st_uid == 0 and
            node_info.st_mode & 0o7022 == 0 and node_info.st_nlink == 1,
            "A protected root-owned Node executable is required")
    root = options.acceptance_root
    require(root.is_absolute() and root.resolve() == root and root.name.startswith("groundwork-native-worker-acceptance"),
            "Use a canonical dedicated native worker acceptance root")
    protected_directory(root.parent)
    if not root.exists():
        root.mkdir(mode=0o755)
        os.chmod(root, 0o755)
    protected_directory(root)
    mirror, hashes = stage_source(repo, root)
    install = root / ("groundwork-native-executor-" + mirror.name[7:])
    subprocess.run(["/usr/bin/bash", str(mirror / "scripts/stage-native-executor.sh"),
                    str(install), str(runtime), str(tcl_library)], check=True, cwd="/", env={
                        "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
                        "GROUNDWORK_NATIVE_NODE_PATH": str(node),
                    }, stdin=subprocess.DEVNULL, close_fds=True)
    suffix = uuid.uuid4().hex[:12]
    group = parent / ("groundwork-native-qa-" + suffix)
    socketdir = pathlib.Path("/run") / ("groundwork-native-qa-" + suffix)
    evidence = root / ("evidence-" + suffix)
    broker = probe = None
    report = flow = None

    def run_node(filename, mode=None):
        args = ["/usr/bin/setpriv", "--reuid=10002", "--regid=10002", "--clear-groups",
                "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs",
                "--", str(node), str(mirror / "scripts/native-executor-probe.mjs"),
                str(socketdir / "executor.sock"), str(mirror / "artifacts/native-acceptance/source.dxf"),
                str(mirror / "artifacts/native-acceptance/source.json"), str(filename)]
        if mode:
            args.append(mode)
        return subprocess.Popen(args, cwd="/", env={"PATH": "/usr/bin:/bin"},
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, close_fds=True)

    try:
        group.mkdir(mode=0o700)
        (group / "cgroup.subtree_control").write_text("+cpu +memory +pids")
        protected_directory(socketdir.parent)
        socketdir.mkdir(mode=0o750)
        os.chown(socketdir, 0, 10002)
        os.chmod(socketdir, 0o750)
        evidence.mkdir(mode=0o700)
        os.chown(evidence, 10002, 10002)
        broker = subprocess.Popen([
            "/usr/bin/python3", "-I", "-S", str(install / "native-executor-broker.py"),
            "--bundle", str(install / "bundle"), "--manifest", str(install / "bundle-manifest.json"),
            "--state-root", str(install / "state"), "--socket", str(socketdir / "executor.sock"),
            "--cgroup-root", str(group),
        ], cwd="/", env={}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE, close_fds=True)
        wait_until(lambda: (socketdir / "executor.sock").exists() or broker.poll() is not None)
        require(broker.poll() is None, "Broker startup refused")
        probe = run_node(evidence / "real-executor.json")
        probe.communicate(timeout=170)
        require(probe.returncode == 0, "Real executor probe failed")
        probe = run_node(evidence / "cancellation.json", "cancel")
        wait_until(lambda: (evidence / "cancellation.json").exists())
        wait_until(lambda: any(path.is_dir() and ATTEMPT.fullmatch(path.name) and
                               (path / "cgroup.procs").read_text().strip() for path in group.iterdir()))
        os.kill(probe.pid, signal.SIGUSR1)
        probe.communicate(timeout=15)
        require(probe.returncode == 0, "Cancellation probe failed")
        wait_until(lambda: not any(ATTEMPT.fullmatch(path.name) for path in group.iterdir()))
        wait_until(lambda: not any(ATTEMPT.fullmatch(path.name) for path in (install / "state").iterdir()))
        report = json.loads((evidence / "real-executor.json").read_text())
        require(all(check["passed"] is True for check in report["checks"]), "A real executor check failed")
        require(json.loads((evidence / "cancellation.json").read_text())["cancelled"] is True,
                "Cancellation was not observed")
        report["checks"].append({"name": "client-EOF-cancels-active-namespace-and-cleans-cgroup", "passed": True})
        if options.with_authority:
            flow = local_authority_flow(repo, root, mirror, node, socketdir, options.authority_uid, options.authority_gid)
            report["checks"].extend(flow["checks"])
    finally:
        terminate(probe, 5)
        terminate(broker)
        if group.exists():
            require(group.parent == parent and group.name == "groundwork-native-qa-" + suffix,
                    "Unexpected acceptance cgroup cleanup path")
            for child in group.iterdir():
                if child.is_dir():
                    require(ATTEMPT.fullmatch(child.name), "Unexpected cgroup child; cleanup refused")
                    (child / "cgroup.kill").write_text("1")
                    wait_until(lambda: not (child / "cgroup.procs").read_text().strip())
                    child.rmdir()
            group.rmdir()
        if socketdir.exists():
            require(socketdir.parent == pathlib.Path("/run") and
                    socketdir.name == "groundwork-native-qa-" + suffix,
                    "Unexpected acceptance socket cleanup path")
            socket = socketdir / "executor.sock"
            if socket.exists():
                require(stat.S_ISSOCK(socket.lstat().st_mode), "Unexpected socket replacement")
                socket.unlink()
            socketdir.rmdir()
    require(report is not None, "No real acceptance report was produced")
    report.update({
        "version": 1, "status": "passed", "productionReady": False,
        "liveAuthorityConnected": False, "networkWorkerPackagingTested": flow is not None,
        "authorityTransportTested": flow is not None, "parentCgroupControllersChanged": False,
        "sourceSha256": hashes, "nodeSha256": digest(node),
        "executorBundleManifestSha256": digest(install / "bundle-manifest.json"),
        "runtimeBinaryManifestSha256": digest(runtime / "binary-sha256.txt"),
        "cleanupCompleted": True,
        "resourceControls": {"memoryMaxBytes": 536870912, "swapMaxBytes": 0,
                             "pidsMax": 32, "cpuMax": "100000 100000", "attemptDeadlineSeconds": 130},
        "limitations": ["Synthetic local Linux executor acceptance only; no live production authority or hosted worker was exercised.",
                        "Closed-form structural checks cover the declared planar elastic subset, not code compliance or professional design approval.",
                        "Aggregate cgroup controls were set and read back; adversarial exhaustion and kernel exploit resistance were not established."],
    })
    if flow:
        report.update({key: value for key, value in flow.items() if key != "checks"})
    write_report(output, report)
    print(json.dumps({"checksPassed": len(report["checks"]), "report": str(output / "report.json")}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Fixed local diagnostics only: no environment values or native logs.
        reason = str(error) if isinstance(error, AcceptanceError) else type(error).__name__
        print("Native worker acceptance failed: " + reason, file=sys.stderr)
        sys.exit(1)
